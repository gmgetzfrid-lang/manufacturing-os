// document-control Round G — P33 VERSION ROW INTEGRITY: 20261247 at RUNTIME
// on the replayed database (the I-17 harness; `npm run test:db`).
//
//   DCK-16  a signed-in session cannot write a revision row as an external
//           submission, through an intake link or as someone else, by INSERT
//           (document_versions_insert_integrity's new limb, and the column
//           guard on every door) or by UPDATE (the column guard);
//   DCK-17  a signed-in session cannot move a revision back into review,
//           clear released_at / superseded_at, or change
//           supersedes_version_id once set (the column guard).
//
// Every statement runs on BOTH sides of the paste, in a transaction that is
// rolled back: "before" is a copy of the replay with 20261247 undone (the
// trigger and its function dropped, 20261214's policy body put back);
// "after" is the replay itself, which ran 20261247. REGRESSION FIRST: every
// lifecycle write the app, the RPCs, the contractor door and the service
// role make today answers the same on both sides; only the forgeries change,
// from admitted to 42501.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const AFTER = REPLAY_DB;
const BEFORE = "mos_dc_p33_before";
const FILE = "20261247_dc_roundG_version_row_integrity.sql";
const POLICY_BASE = "20261214_prj_roundG_intake_door_rls.sql";
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  return s.slice(i, s.indexOf(b, i + a.length) + b.length);
};
/** 20261247 undone: the column guard dropped, 20261214's insert-integrity body put back. */
const UNDO_247 = [
  "DROP TRIGGER IF EXISTS trg_document_version_row_integrity ON document_versions;",
  "DROP FUNCTION IF EXISTS enforce_document_version_row_integrity();",
  between(mig(POLICY_BASE), "DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;", "\n);"),
].join("\n");

const ROLES = { docctrl: "DocCtrl", holder: "Drafter", publisher: "Drafter", author: "Engineer-1", owner: "Viewer", reviewer: "Engineer-1" } as const;
type Member = keyof typeof ROLES;
type Who = Member | "service";

const ids = () => ({
  org: randomUUID(), lib: randomUUID(), project: randomUUID(), link: randomUUID(),
  // dFree: Issued at A (B on file), nobody holds it; fU an unverified-provenance revision on file
  dFree: randomUUID(), fA: randomUUID(), fB: randomUUID(), fU: randomUUID(),
  // dReview: Issued at A, checked out by the holder, pending 2A in review with a complete signed roster
  dReview: randomUUID(), rA: randomUUID(), r2A: randomUUID(), sig: randomUUID(), so: randomUUID(),
  // dIntake: born through the link, Issued at A, checked out by the holder; pending 2A is the door's
  // submission; iOld an ordinary revision on file
  dIntake: randomUUID(), iA: randomUUID(), i2A: randomUUID(), iOld: randomUUID(),
  // dRelabel: Issued at B, checked out by the holder; xA reviewed (approved, released, signed roster)
  // and superseded by xB; xR a rejected draft
  dRelabel: randomUUID(), xA: randomUUID(), xB: randomUUID(), xR: randomUUID(), xSig: randomUUID(), xSo: randomUUID(),
  // dNew: no revision yet (a creation flow's first version)
  dNew: randomUUID(),
  // tLink: a TRUSTED link (allow_auto_supersede) whose creator is the publisher. dTrust: born through it,
  // Issued at tA, nobody holds it (its auto-publish). dTrustR: born through it, Issued at tRA, pending tS
  // its in-review submission (the door's retire / restore / withdraw)
  tLink: randomUUID(), dTrust: randomUUID(), tA: randomUUID(), dTrustR: randomUUID(), tRA: randomUUID(), tS: randomUUID(),
  uid: Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomUUID()])) as Record<Member, string>,
});
type World = ReturnType<typeof ids>;

function seed(db: string, w: World): void {
  const u = w.uid;
  const tag = w.org.slice(0, 8);
  admin(db, `
    INSERT INTO orgs (id, name, type) VALUES ('${w.org}', 'P33 ${tag}', 'business');
    ${(Object.keys(ROLES) as Member[]).map((k) => `
    INSERT INTO auth.users (id, email, aud, role) VALUES ('${u[k]}', '${k}-${tag}@p33.test', 'authenticated', 'authenticated');
    INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${u[k]}', '${k}-${tag}@p33.test', '${k}', '${w.org}');
    INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${w.org}', '${u[k]}', '${k}-${tag}@p33.test', '${ROLES[k]}', ARRAY[]::text[], 'active');`).join("")}
    INSERT INTO libraries (id, org_id, name, type, acl_index) VALUES ('${w.lib}', '${w.org}', 'P33', 'documents',
      '{"allow":{"users":{"publish":["${u.holder}", "${u.publisher}"]}}}'::jsonb);
    INSERT INTO documents (id, org_id, library_id, title, document_number, status, owner_user_id) VALUES
      ('${w.dFree}',    '${w.org}', '${w.lib}', 'Free',    'P33-F-${tag}', 'Draft', '${u.owner}'),
      ('${w.dReview}',  '${w.org}', '${w.lib}', 'Review',  'P33-R-${tag}', 'Draft', '${u.owner}'),
      ('${w.dIntake}',  '${w.org}', '${w.lib}', 'Intake',  'P33-I-${tag}', 'Draft', '${u.owner}'),
      ('${w.dRelabel}', '${w.org}', '${w.lib}', 'Relabel', 'P33-X-${tag}', 'Draft', '${u.owner}'),
      ('${w.dNew}',     '${w.org}', '${w.lib}', 'New',     'P33-N-${tag}', 'Draft', '${u.owner}'),
      ('${w.dTrust}',   '${w.org}', '${w.lib}', 'Trust',   'P33-T-${tag}', 'Draft', '${u.owner}'),
      ('${w.dTrustR}',  '${w.org}', '${w.lib}', 'TrustR',  'P33-TR-${tag}', 'Draft', '${u.owner}');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, created_at) VALUES
      ('${w.fA}', '${w.org}', '${w.dFree}', 'A', 'p33/${tag}/fa.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.fB}', '${w.org}', '${w.dFree}', 'B', 'p33/${tag}/fb.pdf', 'Minor', '${u.publisher}', now() - interval '1 day'),
      ('${w.rA}', '${w.org}', '${w.dReview}', 'A', 'p33/${tag}/ra.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.iA}', '${w.org}', '${w.dIntake}', 'A', 'p33/${tag}/ia.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.iOld}', '${w.org}', '${w.dIntake}', 'A1', 'p33/${tag}/iold.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.tA}', '${w.org}', '${w.dTrust}', 'A', 'p33/${tag}/ta.pdf', 'Minor', '${u.publisher}', now() - interval '2 days'),
      ('${w.tRA}', '${w.org}', '${w.dTrustR}', 'A', 'p33/${tag}/tra.pdf', 'Minor', '${u.publisher}', now() - interval '2 days');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, created_at, provenance) VALUES
      ('${w.fU}', '${w.org}', '${w.dFree}', 'B1', 'p33/${tag}/fu.pdf', 'Minor', '${u.publisher}', now() - interval '1 day', 'unverified');
    UPDATE documents SET current_version_id = '${w.fA}', status = 'Issued', rev = 'A' WHERE id = '${w.dFree}';
    UPDATE documents SET current_version_id = '${w.rA}', status = 'Issued', rev = 'A' WHERE id = '${w.dReview}';
    UPDATE documents SET current_version_id = '${w.iA}', status = 'Issued', rev = 'A' WHERE id = '${w.dIntake}';
    UPDATE documents SET current_version_id = '${w.tA}', status = 'Issued', rev = 'A' WHERE id = '${w.dTrust}';
    UPDATE documents SET current_version_id = '${w.tRA}', status = 'Issued', rev = 'A' WHERE id = '${w.dTrustR}';
    -- history seeded with the triggers off (a roster row born signed is refused to a client — RG-1 — and
    -- an intake row is the door's): the reviewed draft, the reviewed and superseded history, the door's submission
    SET session_replication_role = replica;
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, file_url, change_type, created_by, created_at, supersedes_version_id) VALUES
      ('${w.r2A}', '${w.org}', '${w.dReview}', '2A', 'B', 'in_review', 'p33/${tag}/r2a.pdf', 'Major', '${u.holder}', now() - interval '1 day', '${w.rA}');
    INSERT INTO e_signatures (id, org_id, resource_type, resource_id, document_version_id, intent, statement, signer_user_id, signer_name)
      VALUES ('${w.sig}', '${w.org}', 'document_version', '${w.r2A}', '${w.r2A}', 'Approved', 'I approve', '${u.reviewer}', 'reviewer');
    INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at)
      VALUES ('${w.so}', '${w.org}', '${w.dReview}', '${w.r2A}', '${u.reviewer}', 'primary', true, 'signed', '${w.sig}', now());
    UPDATE documents SET pending_version_id = '${w.r2A}' WHERE id = '${w.dReview}';
    INSERT INTO document_versions (id, org_id, record_id, revision_label, review_state, file_url, change_type, created_by, created_at, released_at, superseded_at, supersedes_version_id) VALUES
      ('${w.xA}', '${w.org}', '${w.dRelabel}', 'A', 'superseded', 'p33/${tag}/xa.pdf', 'Major', '${u.holder}', now() - interval '3 days', now() - interval '3 days', now() - interval '1 day', NULL),
      ('${w.xB}', '${w.org}', '${w.dRelabel}', 'B', 'approved', 'p33/${tag}/xb.pdf', 'Minor', '${u.holder}', now() - interval '1 day', now() - interval '1 day', NULL, '${w.xA}'),
      ('${w.xR}', '${w.org}', '${w.dRelabel}', 'CA', 'rejected', 'p33/${tag}/xr.pdf', 'Minor', '${u.holder}', now() - interval '1 day', NULL, NULL, '${w.xB}');
    INSERT INTO e_signatures (id, org_id, resource_type, resource_id, document_version_id, intent, statement, signer_user_id, signer_name)
      VALUES ('${w.xSig}', '${w.org}', 'document_version', '${w.xA}', '${w.xA}', 'Approved', 'I approve', '${u.reviewer}', 'reviewer');
    INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at)
      VALUES ('${w.xSo}', '${w.org}', '${w.dRelabel}', '${w.xA}', '${u.reviewer}', 'primary', true, 'signed', '${w.xSig}', now() - interval '3 days');
    UPDATE documents SET current_version_id = '${w.xB}', status = 'Issued', rev = 'B' WHERE id = '${w.dRelabel}';
    INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${w.project}', '${w.org}', 'P33 project', '${u.owner}', '${u.owner}');
    INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids)
      VALUES ('${w.link}', '${w.org}', '${w.project}', 'Contractor Co', md5('${w.link}') || md5('${w.org}'), now() + interval '30 days', '${u.owner}', ARRAY[]::uuid[]);
    UPDATE documents SET authored_by_link_id = '${w.link}' WHERE id = '${w.dIntake}';
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by, created_by_name, created_at, supersedes_version_id) VALUES
      ('${w.i2A}', '${w.org}', '${w.dIntake}', '2A', 'B', 'in_review', 'external', '${w.link}', 'p33/${tag}/i2a.pdf', 'Major', '${w.link}', 'Contractor Co', now() - interval '1 day', '${w.iA}');
    UPDATE documents SET pending_version_id = '${w.i2A}' WHERE id = '${w.dIntake}';
    INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids, allow_auto_supersede)
      VALUES ('${w.tLink}', '${w.org}', '${w.project}', 'Trusted Co', md5('${w.tLink}') || md5('${w.org}'), now() + interval '30 days', '${u.publisher}', ARRAY[]::uuid[], true);
    UPDATE documents SET authored_by_link_id = '${w.tLink}' WHERE id IN ('${w.dTrust}', '${w.dTrustR}');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by, created_by_name, created_at, supersedes_version_id) VALUES
      ('${w.tS}', '${w.org}', '${w.dTrustR}', '2A', 'B', 'in_review', 'external', '${w.tLink}', 'p33/${tag}/ts.pdf', 'Major', '${w.tLink}', 'Trusted Co', now() - interval '1 day', '${w.tRA}');
    UPDATE documents SET pending_version_id = '${w.tS}' WHERE id = '${w.dTrustR}';
    RESET session_replication_role;
    UPDATE documents SET checked_out_by = '${u.holder}', checked_out_by_name = 'Holder Person', checked_out_at = now()
     WHERE id IN ('${w.dReview}', '${w.dIntake}', '${w.dRelabel}');`);
}

/** Statements as `who`, each its own savepointed call (a sequence of PostgREST requests), in ONE
 *  transaction that is rolled back. `prelude` runs first as the superuser; `after` reads what was written. */
function probeSeq(db: string, w: World, who: Who, stmts: string[], after?: string, prelude = ""): string {
  const { conn } = mosDb();
  const claims = who === "service" ? { role: "service_role" } : { role: "authenticated", sub: w.uid[who] };
  const role = who === "service" ? "service_role" : "authenticated";
  const sql = [
    "BEGIN;",
    ...(prelude ? [prelude] : []),
    `SET LOCAL ROLE ${role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(JSON.stringify(claims))}, true);`,
    ...stmts.map((st) => `SELECT harness.try_sql(${dollarQuote(st)});`),
    ...(after ? ["RESET ROLE;", after] : []),
    "ROLLBACK;",
  ].join("\n");
  const r = runPsql(conn!, db, conn!.superuser, { sql });
  if (!r.ok) throw new Error(`probe failed on ${db} as ${who}: ${r.error ?? r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0).slice(1).join(" / ");
}

const DROP_NOT_NULL = "ALTER TABLE document_versions ALTER COLUMN created_by DROP NOT NULL;";
const ver = (id: string) => `SELECT COALESCE(review_state, 'none') || '|' || COALESCE(provenance, 'none') || '|' || COALESCE(intake_link_id::text, 'none') || '|' ||
  COALESCE(created_by::text, 'none') || '|' || (released_at IS NOT NULL) || '|' || (superseded_at IS NOT NULL) || '|' || COALESCE(supersedes_version_id::text, 'none')
  FROM document_versions WHERE id = '${id}';`;
const pointer = (doc: string) => `SELECT COALESCE(current_version_id::text, 'none') FROM documents WHERE id = '${doc}';`;
const REFUSED = /^err:42501:/;

describe.skipIf(skip !== null)("DCK-16 / DCK-17 (20261247): the version row's intake and lifecycle columns, before and after the paste", () => {
  let w: World;
  beforeAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${AFTER}`);
    admin(BEFORE, UNDO_247);
    w = ids();
    seed(BEFORE, w);
    seed(AFTER, w);
  });
  afterAll(() => { admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`); });

  const both = (who: Who, stmts: string[], after?: string, prelude = "") =>
    ({ before: probeSeq(BEFORE, w, who, stmts, after, prelude), after: probeSeq(AFTER, w, who, stmts, after, prelude) });

  it("the two sides are what they say: the replay carries the column guard and the new limb, the copy carries neither", () => {
    const has = (db: string) => admin(db, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_version_row_integrity')
      AND (SELECT with_check LIKE '%provenance IS DISTINCT FROM%' FROM pg_policies WHERE tablename = 'document_versions' AND policyname = 'document_versions_insert_integrity')`);
    expect(has(AFTER)).toBe("t");
    expect(has(BEFORE)).toBe("f");
  });

  describe("DCK-16 — the intake columns", () => {
    const forged = (doc: string, creator: string, extra = "'external', 'LINK'") =>
      `INSERT INTO document_versions (org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by)
       VALUES ('${w.org}', '${doc}', '3A', 'B', 'in_review', ${extra.replace("LINK", w.link)}, 'p33/forged.pdf', 'Major', ${creator})`;

    it("THE DEFECT, closed: a library publisher's INSERT of a member-less 'external' draft naming the link that scopes the document (creator the link's id, or NULL) — admitted before, refused 42501 after", () => {
      const a = both("publisher", [forged(w.dIntake, `'${w.link}'`)]);
      expect(a.before).toBe("ok:1");
      expect(a.after).toMatch(REFUSED);
      const b = both("publisher", [forged(w.dIntake, "NULL")], undefined, DROP_NOT_NULL);
      expect(b.before).toBe("ok:1");
      expect(b.after).toMatch(REFUSED);
    });

    it("a publisher's INSERT naming an intake link without the 'external' mark, or 'external' without a link, or a draft recorded as created by someone else — admitted before, refused after", () => {
      const linkOnly = both("publisher", [forged(w.dIntake, `'${w.uid.publisher}'`, "NULL, 'LINK'")]);
      expect(linkOnly.before).toBe("ok:1");
      expect(linkOnly.after).toMatch(REFUSED);
      const extOnly = both("publisher", [forged(w.dIntake, `'${w.uid.publisher}'`, "'external', NULL")]);
      expect(extOnly.before).toBe("ok:1");
      expect(extOnly.after).toMatch(REFUSED);
      const other = both("publisher", [forged(w.dFree, `'${w.uid.holder}'`, "NULL, NULL")]);
      expect(other.before).toBe("ok:1");
      expect(other.after).toMatch(REFUSED);
    });

    it("THE DEFECT, by UPDATE, closed: re-shaping an ordinary revision as the door's submission, then promoting it over the holder's checkout — three writes admitted before; after, the re-shape is refused, the row is unchanged and the promote is refused by the lock leg (the row is not in review)", () => {
      const reshape = [
        `UPDATE document_versions SET review_state = 'in_review', provenance = 'external', intake_link_id = '${w.link}', created_by = '${w.link}' WHERE id = '${w.iOld}'`,
        `UPDATE documents SET pending_version_id = '${w.iOld}' WHERE id = '${w.dIntake}'`,
        `UPDATE documents SET current_version_id = '${w.iOld}', rev = 'A1', revision = 'A1', status = 'Issued', pending_version_id = NULL
          WHERE id = '${w.dIntake}' AND pending_version_id = '${w.iOld}' AND current_version_id = '${w.iA}'`,
      ];
      const r = both("publisher", reshape, `${pointer(w.dIntake)} ${ver(w.iOld)}`);
      expect(r.before).toMatch(new RegExp(`^ok:1 / ok:1 / ok:1 / ${w.iOld} / in_review\\|external\\|${w.link}\\|${w.link}\\|`));
      expect(r.after).toMatch(new RegExp(`^err:42501:.* / ok:1 / err:42501:This document is checked out by Holder Person, .* / ${w.iA} / none\\|none\\|none\\|${w.uid.holder}\\|`));
    });

    it("each intake column alone, by UPDATE — the link, the creator, provenance onto or off 'external' — admitted before, refused after", () => {
      for (const st of [
        `UPDATE document_versions SET intake_link_id = '${w.link}' WHERE id = '${w.iOld}'`,
        `UPDATE document_versions SET created_by = '${w.uid.publisher}' WHERE id = '${w.iOld}'`,
        `UPDATE document_versions SET provenance = 'external' WHERE id = '${w.iOld}'`,
        `UPDATE document_versions SET provenance = 'declared' WHERE id = '${w.i2A}'`,
        `UPDATE document_versions SET intake_link_id = NULL WHERE id = '${w.i2A}'`,
      ]) {
        const r = both("publisher", [st]);
        expect(r.before, st).toBe("ok:1");
        expect(r.after, st).toMatch(REFUSED);
      }
    });

    it("publish_revision is no way round it: a signed-in publish whose version names provenance 'external' — published before, refused after (no app path sends it)", () => {
      const stmt = `SELECT 1 FROM (SELECT publish_revision(p_doc := '${w.dFree}', p_expected_base := '${w.fA}', p_op_class := 'content',
         p_version := '{"revision_label":"C","file_url":"p33/c.pdf","change_type":"Minor","change_log":"p33","provenance":"external"}'::jsonb,
         p_actor := NULL) AS r) x WHERE x.r->>'status' = 'published'`;
      const r = both("publisher", [stmt]);
      expect(r.before).toBe("ok:1");
      expect(r.after).toMatch(REFUSED);
    });
  });

  describe("DCK-17 — the lifecycle columns", () => {
    it("THE DEFECT, closed: relabelling an earlier reviewed revision (approved, released, superseded, a signed roster) back to in_review, pointing at it and promoting it over the holder's checkout — admitted before (an unrecorded revert); after, the relabel is refused and the promote is refused by the lock leg, the pointer stays on B", () => {
      const relabel = [
        `UPDATE document_versions SET review_state = 'in_review' WHERE id = '${w.xA}'`,
        `UPDATE documents SET pending_version_id = '${w.xA}' WHERE id = '${w.dRelabel}'`,
        `UPDATE documents SET current_version_id = '${w.xA}', rev = 'A', revision = 'A', pending_version_id = NULL WHERE id = '${w.dRelabel}'`,
      ];
      const r = both("publisher", relabel, pointer(w.dRelabel));
      expect(r.before).toBe(`ok:1 / ok:1 / ok:1 / ${w.xA}`);
      expect(r.after).toMatch(new RegExp(`^err:42501:A revision that is not in review .* / ok:1 / err:42501:This document is checked out by Holder Person, .* / ${w.xB}$`));
    });

    it("back into review from approved, rejected, superseded — or from no review state at all — is refused after (admitted before), Document Control included", () => {
      for (const [who, id] of [["publisher", w.xB], ["publisher", w.xR], ["publisher", w.xA], ["publisher", w.fB], ["docctrl", w.xA]] as const) {
        const r = both(who, [`UPDATE document_versions SET review_state = 'in_review' WHERE id = '${id}'`]);
        expect(r.before, `${who} ${id}`).toBe("ok:1");
        expect(r.after, `${who} ${id}`).toMatch(REFUSED);
      }
    });

    it("a release, a supersession and the revision superseded are history: clearing released_at or superseded_at, or changing supersedes_version_id once set (to another revision or to none), is refused after (admitted before)", () => {
      for (const st of [
        `UPDATE document_versions SET released_at = NULL WHERE id = '${w.xB}'`,
        `UPDATE document_versions SET superseded_at = NULL WHERE id = '${w.xA}'`,
        `UPDATE document_versions SET supersedes_version_id = NULL WHERE id = '${w.xB}'`,
        `UPDATE document_versions SET supersedes_version_id = '${w.xR}' WHERE id = '${w.xB}'`,
        `UPDATE document_versions SET supersedes_version_id = '${w.iOld}' WHERE id = '${w.i2A}'`,
      ]) {
        const r = both("publisher", [st]);
        expect(r.before, st).toBe("ok:1");
        expect(r.after, st).toMatch(REFUSED);
      }
    });
  });

  describe("DCK-17 — a reviewed draft stays on the document it was reviewed for", () => {
    it("moving dReview's reviewed pending draft (complete signed roster) onto dRelabel, pointing at it and promoting it over the holder's checkout — admitted before (the roster limb follows the version id); after, the move is refused and nothing is promoted", () => {
      const move = [
        `UPDATE document_versions SET record_id = '${w.dRelabel}' WHERE id = '${w.r2A}'`,
        `UPDATE documents SET pending_version_id = '${w.r2A}' WHERE id = '${w.dRelabel}'`,
        `UPDATE documents SET current_version_id = '${w.r2A}', rev = '2A', revision = '2A', pending_version_id = NULL WHERE id = '${w.dRelabel}'`,
      ];
      const r = both("publisher", move, pointer(w.dRelabel));
      expect(r.before).toBe(`ok:1 / ok:1 / ok:1 / ${w.r2A}`);
      expect(r.after.startsWith("err:42501:A revision belongs to the document it was filed on")).toBe(true);
      expect(r.after.endsWith(` / ${w.xB}`)).toBe(true);
    });
  });

  describe("REGRESSION — every legitimate writer answers the same on both sides", () => {
    it("submit for review: the author's own in-review draft (created by itself, superseding the live revision), then its race-loser retire and a resubmission's retire of the earlier draft", () => {
      const id = randomUUID();
      const r = both("holder", [
        `INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, file_url, change_type, change_log, created_by, created_by_name, created_at, supersedes_version_id)
         VALUES ('${id}', '${w.org}', '${w.dFree}', 'BA', 'B', 'in_review', 'p33/sub.pdf', 'Major', 'p33', '${w.uid.holder}', 'holder', now(), '${w.fA}')`,
        `UPDATE document_versions SET superseded_at = now() WHERE id = '${id}'`,
      ], ver(id));
      expect(r.before).toBe(`ok:1 / ok:1 / in_review|none|none|${w.uid.holder}|false|true|${w.fA}`);
      expect(r.after).toBe(r.before);
    });

    it("a creation flow's FIRST version (upload-and-link, bulk upload, split / merge targets) by its creator", () => {
      const r = both("author", [`INSERT INTO document_versions (org_id, record_id, revision_label, file_url, change_type, created_by, released_at)
        VALUES ('${w.org}', '${w.dNew}', 'A', 'p33/new.pdf', 'Minor', '${w.uid.author}', now())`]);
      expect(r.before).toBe("ok:1");
      expect(r.after).toBe(r.before);
    });

    it("finalize_reviewed_promote by a publisher, or Document Control, who does not hold the checkout: the reviewed draft is promoted (approved, released, superseding A) and A is superseded — on both sides", () => {
      const stmt = `SELECT 1 WHERE finalize_reviewed_promote('${w.dReview}', '${w.r2A}', '${w.rA}', 'B', NULL) = 'promoted'`;
      for (const who of ["publisher", "docctrl"] as const) {
        const r = both(who, [stmt], `${pointer(w.dReview)} ${ver(w.r2A)} ${ver(w.rA)}`);
        expect(r.before, who).toBe(`ok:1 / ${w.r2A} / approved|none|none|${w.uid.holder}|true|false|${w.rA} / none|none|none|${w.uid.holder}|false|true|none`);
        expect(r.after, who).toBe(r.before);
      }
    });

    it("promoteThreeStep's writes (the pointer, the relabel with supersedes_version_id, the prior's superseded_at), then provenance declared on the promoted draft — on both sides", () => {
      const r = both("publisher", [
        `UPDATE documents SET current_version_id = '${w.r2A}', rev = 'B', revision = 'B', status = 'Issued', pending_version_id = NULL
          WHERE id = '${w.dReview}' AND pending_version_id = '${w.r2A}' AND current_version_id = '${w.rA}'`,
        `UPDATE document_versions SET review_state = 'approved', revision_label = 'B', released_at = now(), supersedes_version_id = '${w.rA}', updated_at = now() WHERE id = '${w.r2A}'`,
        `UPDATE document_versions SET superseded_at = now() WHERE id = '${w.rA}'`,
        `UPDATE document_versions SET provenance = 'declared' WHERE id = '${w.r2A}' AND provenance IS NULL`,
      ], ver(w.r2A));
      expect(r.before).toBe(`ok:1 / ok:1 / ok:1 / ok:1 / approved|declared|none|${w.uid.holder}|true|false|${w.rA}`);
      expect(r.after).toBe(r.before);
    });

    it("a GENUINE external submission approved from the Intake tab (finalize_reviewed_promote, no roster) by a publisher who does not hold the checkout — promoted on both sides, its door marks kept", () => {
      const stmt = `SELECT 1 WHERE finalize_reviewed_promote('${w.dIntake}', '${w.i2A}', '${w.iA}', 'B', NULL) = 'promoted'`;
      const r = both("publisher", [stmt], `${pointer(w.dIntake)} ${ver(w.i2A)}`);
      expect(r.before).toBe(`ok:1 / ${w.i2A} / approved|external|${w.link}|${w.link}|true|false|${w.iA}`);
      expect(r.after).toBe(r.before);
    });

    it("the Intake tab's reject (in_review → rejected, with its reason) and its MOC note on the door's submission — on both sides", () => {
      const r = both("publisher", [
        `UPDATE document_versions SET moc_reference = 'MOC-1' WHERE id = '${w.i2A}' AND review_state = 'in_review'`,
        `UPDATE document_versions SET review_state = 'rejected', review_note = 'redo the title block' WHERE id = '${w.i2A}'`,
      ], ver(w.i2A));
      expect(r.before).toBe(`ok:1 / ok:1 / rejected|external|${w.link}|${w.link}|false|false|${w.iA}`);
      expect(r.after).toBe(r.before);
    });

    it("void a pending draft, Document Control's provenance verification, a label correction and an effective date — on both sides", () => {
      const r = both("docctrl", [
        `UPDATE document_versions SET superseded_at = now() WHERE id = '${w.r2A}' AND superseded_at IS NULL`,
        `UPDATE document_versions SET provenance = 'declared', provenance_verified_at = now(), provenance_verified_by = 'dc' WHERE id = '${w.fU}'`,
        `UPDATE document_versions SET revision_label = 'B2' WHERE id = '${w.fB}'`,
        `UPDATE document_versions SET effective_date = current_date WHERE id = '${w.fA}'`,
      ]);
      expect(r.before).toBe("ok:1 / ok:1 / ok:1 / ok:1");
      expect(r.after).toBe(r.before);
    });

    it("publish_revision (an ordinary rev-up on an unlocked document: its row created by the session, the prior superseded) — published on both sides", () => {
      const stmt = `SELECT 1 FROM (SELECT publish_revision(p_doc := '${w.dFree}', p_expected_base := '${w.fA}', p_op_class := 'content',
         p_version := '{"revision_label":"C","file_url":"p33/c.pdf","change_type":"Minor","change_log":"p33"}'::jsonb,
         p_actor := NULL) AS r) x WHERE x.r->>'status' = 'published'`;
      const r = both("publisher", [stmt], `SELECT (SELECT created_by::text FROM document_versions v WHERE v.id = d.current_version_id) || '|' ||
        (SELECT (superseded_at IS NOT NULL)::text FROM document_versions WHERE id = '${w.fA}') FROM documents d WHERE d.id = '${w.dFree}';`);
      expect(r.before).toBe(`ok:1 / ${w.uid.publisher}|true`);
      expect(r.after).toBe(r.before);
    });

    it("the service role (the intake route's legacy insert of a member-less 'external' row with its link, its withdrawal and the withdrawal's restore, the provenance stamp after a trusted publish) is not judged — on both sides", () => {
      const id = randomUUID();
      const r = both("service", [
        `INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by, created_at)
         VALUES ('${id}', '${w.org}', '${w.dIntake}', '3A', 'B', 'in_review', 'external', '${w.link}', 'p33/route.pdf', 'Major', NULL, now())`,
        `UPDATE document_versions SET review_state = 'superseded', superseded_at = now() WHERE id = '${id}'`,
        `UPDATE document_versions SET superseded_at = NULL WHERE id = '${id}'`,
        `UPDATE document_versions SET review_state = 'in_review' WHERE id = '${id}'`,
        `UPDATE document_versions SET intake_link_id = '${w.link}' WHERE id = '${w.iOld}'`,
      ], ver(id), DROP_NOT_NULL);
      expect(r.before).toBe(`ok:1 / ok:1 / ok:1 / ok:1 / ok:1 / in_review|external|${w.link}|none|false|false|none`);
      expect(r.after).toBe(r.before);
    });

    it("the contractor door: intake_door_submit_version (service key; the INSERT as the role intake_door under its bound identity) files its in-review external submission on both sides", () => {
      const hash = admin(AFTER, `SELECT token_hash FROM project_intake_links WHERE id = '${w.link}'`);
      const stmt = `SELECT 1 WHERE intake_door_submit_version('${hash}', jsonb_build_object(
        'record_id', '${w.dIntake}', 'revision_label', '3A', 'file_url', 'orgs/${w.org}/project-intake/${w.project}/door.pdf',
        'created_by_name', 'Contractor Co', 'supersedes_version_id', '${w.iA}')) IS NOT NULL`;
      const after = `SELECT count(*) FROM document_versions WHERE record_id = '${w.dIntake}' AND revision_label = '3A' AND provenance = 'external' AND intake_link_id = '${w.link}' AND review_state = 'in_review';`;
      const r = both("service", [stmt], after, DROP_NOT_NULL);
      expect(r.before).toBe("ok:1 / 1");
      expect(r.after).toBe(r.before);
    });

    // The two door writers below run as the function's owner with the door's identity BOUND in the
    // request claims (intake_door_bind: auth.uid() = the creator or the link, role 'intake_door') —
    // CURRENT_USER is not intake_door, so it is the guard's claims branch alone that exempts them.
    const trustHash = () => admin(AFTER, `SELECT token_hash FROM project_intake_links WHERE id = '${w.tLink}'`);
    const AT = "2026-10-21T08:00:00+00";

    it("the contractor door: intake_door_promote (a TRUSTED link's auto-publish, bound as the link's creator; publish_revision writes an 'external' row created by that member, then the door stamps its intake_link_id) publishes on both sides — the claims branch exempts it", () => {
      const stmt = `SELECT 1 FROM (SELECT intake_door_promote('${trustHash()}', '${w.dTrust}', '${w.tA}', jsonb_build_object(
          'revision_label', 'B', 'file_url', 'orgs/${w.org}/project-intake/${w.project}/trusted.pdf', 'change_log', 'p33',
          'created_by_name', 'Trusted Co'), 'Trusted Co (intake)') AS r) x
        WHERE x.r->>'status' = 'published' AND x.r->>'intake_link_stamped' = 'true'`;
      const after = `SELECT v.provenance || '|' || COALESCE(v.intake_link_id::text, 'none') || '|' || v.created_by::text || '|' || COALESCE(v.review_state, 'none')
        || '|' || (v.supersedes_version_id = '${w.tA}')::text FROM documents d JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = '${w.dTrust}';`;
      const r = both("service", [stmt], after);
      expect(r.before).toBe(`ok:1 / external|${w.tLink}|${w.uid.publisher}|none|true`);
      expect(r.after).toBe(r.before);
    });

    it("the contractor door: intake_door_housekeep 'retire' then 'restore' (the same stamp) of a displaced submission — superseded_at cleared and superseded → in_review, both of which the guard refuses a signed-in session — answer the same on both sides", () => {
      const r = both("service", [
        `SELECT 1 WHERE intake_door_housekeep('${trustHash()}', 'retire', '${w.dTrustR}', '${w.tS}', '${AT}') = 1`,
        `SELECT 1 FROM document_versions WHERE id = '${w.tS}' AND review_state = 'superseded' AND superseded_at = '${AT}'`,
        `SELECT 1 WHERE intake_door_housekeep('${trustHash()}', 'restore', '${w.dTrustR}', '${w.tS}', '${AT}') = 1`,
      ], ver(w.tS));
      expect(r.before).toBe(`ok:1 / ok:1 / ok:1 / in_review|external|${w.tLink}|${w.tLink}|false|false|${w.tRA}`);
      expect(r.after).toBe(r.before);
    });

    it("the contractor door: intake_door_housekeep 'withdraw' of its own submission — superseded on both sides", () => {
      const r = both("service", [
        `SELECT 1 WHERE intake_door_housekeep('${trustHash()}', 'withdraw', '${w.dTrustR}', '${w.tS}', '${AT}') = 1`,
      ], ver(w.tS));
      expect(r.before).toBe(`ok:1 / superseded|external|${w.tLink}|${w.tLink}|false|true|${w.tRA}`);
      expect(r.after).toBe(r.before);
    });

    it("the guard's own door exemption is the bound claims: the same restore attempted by a signed-in publisher (a direct UPDATE) is admitted before and refused after", () => {
      const r = both("publisher", [
        `UPDATE document_versions SET review_state = 'superseded', superseded_at = '${AT}' WHERE id = '${w.tS}'`,
        `UPDATE document_versions SET superseded_at = NULL WHERE id = '${w.tS}'`,
        `UPDATE document_versions SET review_state = 'in_review' WHERE id = '${w.tS}'`,
      ]);
      expect(r.before).toBe("ok:1 / ok:1 / ok:1");
      expect(r.after).toMatch(/^ok:1 \/ err:42501:.* \/ err:42501:/);
    });
  });
});

describe.skipIf(skip !== null)("20261247 pasted as ONE script, as the SQL editor sends it", () => {
  const SCRATCH = "mos_dc_p33_paste";
  const paste = (db: string) => runPsql(mosDb().conn!, db, "postgres", { sql: mig(FILE) });
  const rows = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });

  it("on a copy with 20261247 undone: every probe true, the four inventory rows are counts, and a re-paste is clean — and the inventory counts the forgery signatures only: legitimate retired drafts, the door's submission and a trusted auto-publish do not count, a forged submission and a forged relabel (and a pointer to it) do", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    const o = { org: randomUUID(), user: randomUUID(), lib: randomUUID(), doc: randomUUID(), link: randomUUID(),
      cur: randomUUID(), voided: randomUUID(), resub: randomUUID(), door: randomUUID(), trusted: randomUUID(), fSub: randomUUID(), fRel: randomUUID() };
    const vrow = (id: string, label: string, extra: string) =>
      `('${id}', '${o.org}', '${o.doc}', '${label}', 'p33inv/${id}.pdf', 'Minor', ${extra})`;
    const COLS = "INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, review_state, provenance, intake_link_id, released_at, superseded_at) VALUES";
    // as the superuser with the triggers off: a world the inventory reads (rows only — it never judges a write)
    const legit = `SET session_replication_role = replica;
      INSERT INTO orgs (id, name, type) VALUES ('${o.org}', 'P33 inventory', 'business');
      INSERT INTO auth.users (id, email, aud, role) VALUES ('${o.user}', 'inv-${o.org.slice(0, 8)}@p33.test', 'authenticated', 'authenticated');
      INSERT INTO libraries (id, org_id, name, type) VALUES ('${o.lib}', '${o.org}', 'P33 inventory', 'documents');
      INSERT INTO documents (id, org_id, library_id, title, document_number, status) VALUES ('${o.doc}', '${o.org}', '${o.lib}', 'Inv', 'P33-INV-${o.org.slice(0, 8)}', 'Issued');
      ${COLS}
        ${vrow(o.cur, "A", `'${o.user}', NULL, NULL, NULL, now(), NULL`)},
        ${vrow(o.voided, "AA", `'${o.user}', 'in_review', NULL, NULL, NULL, now()`)},
        ${vrow(o.resub, "AB", `'${o.user}', 'in_review', NULL, NULL, NULL, now()`)},
        ${vrow(o.door, "AC", `'${o.link}', 'in_review', 'external', '${o.link}', NULL, NULL`)},
        ${vrow(o.trusted, "B", `'${o.user}', NULL, 'external', '${o.link}', now(), NULL`)};
      UPDATE documents SET current_version_id = '${o.trusted}', pending_version_id = '${o.door}' WHERE id = '${o.doc}';
      RESET session_replication_role;`;
    const forged = `SET session_replication_role = replica;
      ${COLS}
        ${vrow(o.fSub, "AD", `'${o.user}', 'in_review', 'external', '${o.link}', NULL, NULL`)},
        ${vrow(o.fRel, "AE", `'${o.user}', 'in_review', NULL, NULL, now(), now()`)};
      UPDATE documents SET pending_version_id = '${o.fRel}' WHERE id = '${o.doc}';
      RESET session_replication_role;`;
    const LABELS = { external: "external submissions (informational", submission: "IN REVIEW recorded as external", relabel: "already RELEASED", pointer: "pending pointer names" } as const;
    type Counts = Record<keyof typeof LABELS, number>;
    try {
      admin(SCRATCH, UNDO_247);
      const counts: Counts[] = [];
      for (let pass = 0; pass < 3; pass++) {
        if (pass === 1) admin(SCRATCH, legit);
        if (pass === 2) admin(SCRATCH, forged);
        const r = paste(SCRATCH);
        expect(r.errors, r.stderr).toEqual([]);
        const all = rows(r.stdout);
        const probes = all.filter((x) => x.ok !== "");
        const inventory = all.filter((x) => x.ok === "");
        expect(probes.length, `pass ${pass}`).toBe(7);
        expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
        expect(probes.every((p) => p.n === "")).toBe(true);
        expect(inventory.length).toBe(4);
        expect(inventory.every((x) => /^\d+$/.test(x.n)), JSON.stringify(inventory)).toBe(true);
        const c = {} as Counts;
        for (const [k, label] of Object.entries(LABELS) as Array<[keyof typeof LABELS, string]>) {
          const hit = inventory.filter((x) => x.check.includes(label));
          expect(hit.length, label).toBe(1);
          c[k] = Number(hit[0].n);
        }
        counts.push(c);
      }
      // legitimate data: the door's submission and the trusted auto-publish are external (informational row),
      // and nothing else moves — the two drafts retired in review and the published external row are not forgeries
      expect(counts[1]).toEqual({ ...counts[0], external: counts[0].external + 2 });
      // the forgeries: a member-created in-review 'external' row, a released revision relabelled in review and
      // the pending pointer naming it — each counted once
      expect(counts[2]).toEqual({ external: counts[1].external + 1, submission: counts[1].submission + 1, relabel: counts[1].relabel + 1, pointer: counts[1].pointer + 1 });
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });

  it("the prerequisite refuses, changing nothing, on a database whose publish guard has no lock leg (20261193's) and on one whose insert policy has no door limb (20261205's)", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, UNDO_247);
      const g = mig("20261193_dc_roundF_ifc_rev_up_first_issue.sql");
      const head = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
      const guard = g.slice(g.indexOf(head), g.indexOf("\n$$;", g.indexOf(head)) + 4);
      const state = () => admin(SCRATCH, `SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_document_version_row_integrity')::text || md5((SELECT with_check FROM pg_policies WHERE tablename = 'document_versions' AND policyname = 'document_versions_insert_integrity'))`);
      admin(SCRATCH, guard);
      const was = state();
      const a = paste(SCRATCH);
      expect(a.stderr).toContain("20261247 needs 20261245 (the checkout lock leg in the publish guard) pasted first; nothing was changed.");
      expect(state()).toBe(was);
      admin(SCRATCH, between(mig("20261245_dc_roundG_publish_guard_lock_leg.sql"), head, "\n$$;"));
      admin(SCRATCH, between(mig("20261205_dc_roundF_direct_write_issue_record.sql"), "DROP POLICY IF EXISTS document_versions_insert_integrity ON document_versions;", "\n);"));
      const was2 = state();
      const b = paste(SCRATCH);
      expect(b.stderr).toContain("20261247 needs 20261214 (the intake door limb of document_versions_insert_integrity) pasted first; nothing was changed.");
      expect(state()).toBe(was2);
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });
});
