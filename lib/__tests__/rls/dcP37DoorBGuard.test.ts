// document-control Round G — P37 DOOR B GUARD: 20261254 at RUNTIME on the
// replayed database (the I-17 harness; `npm run test:db`).
//
//   DCK-18 (a)  a door-(b) write over another person's checkout made outside
//               finalize_reviewed_promote — the three-step PATCH sent by hand —
//               is recorded (REVIEW_PROMOTED_OVER_CHECKOUT, via 'database',
//               promote 'direct_write') and the holder told (the existing
//               kind revision_published_over_checkout) by the publish guard,
//               in the write's own statement; never a refusal, and never a
//               second record beside finalize_reviewed_promote's own.
//   DCK-18 (b)  door (b)'s intake limb admits only a submission the database
//               can vouch for — the door's own INTAKE_DOOR_SUBMITTED record
//               (intake_door_submit_version, in the door's transaction, both
//               paths; P37 final fix pass), the intake route's INTAKE_SUBMISSION
//               record, or that record's server dead letter: a pre-paste
//               door-shaped row with none is refused 42501 over a checkout;
//               every genuine submission — both door paths, its route record
//               written or lost — still promotes.
//   REV-37 (1)  retire_over_hold's recorded reversal_park is bound to the
//               reversal being run (an unreversed recorded split / merge
//               naming the document).
//   REV-37 (2)  a signed-in session's REV_HOLD_OVERRIDDEN row is admitted only
//               in the transaction that wrote the document it names.
//
// Every statement runs on BOTH sides of the paste, in a transaction that is
// rolled back: "before" is a copy of the replay with 20261254 undone (the
// guard and retire_over_hold put back from 20261253, finalize_reviewed_promote
// from 20261252, intake_door_submit_version from 20261214, the rail dropped);
// "after" is the replay itself. REGRESSION
// FIRST: everything a legitimate user does lands exactly as before.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const AFTER = REPLAY_DB;
const BEFORE = "mos_dc_p37_before";
const FILE = "20261254_dc_roundG_door_b_guard.sql";
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  return s.slice(i, s.indexOf(b, i + a.length) + b.length);
};
const S253 = "20261253_dc_roundG_status_editor_hold_leg.sql";
const S252 = "20261252_dc_roundG_door_b_record.sql";
const S214 = "20261214_prj_roundG_intake_door_rls.sql";
/** 20261254 undone: the guard and retire_over_hold from 20261253, finalize_reviewed_promote from 20261252,
 *  intake_door_submit_version from 20261214, the rail dropped. */
const UNDO_254 = [
  between(mig(S253), "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "\n$$;"),
  "REVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;",
  between(mig(S252), "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(", "\n$$;"),
  "REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) FROM PUBLIC, anon;",
  "GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean) TO authenticated, service_role;",
  between(mig(S253), "CREATE OR REPLACE FUNCTION retire_over_hold(", "\n$$;"),
  between(mig(S214), "CREATE OR REPLACE FUNCTION public.intake_door_submit_version(p_token_hash text, p_version jsonb)", "\n$$;"),
  "REVOKE ALL ON FUNCTION public.intake_door_submit_version(text, jsonb) FROM PUBLIC, anon, authenticated;",
  "GRANT EXECUTE ON FUNCTION public.intake_door_submit_version(text, jsonb) TO service_role;",
  "DROP TRIGGER IF EXISTS trg_audit_logs_hold_override_rail ON audit_logs;",
  "DROP FUNCTION IF EXISTS public.enforce_hold_override_record_rail();",
].join("\n");

const ROLES = { docctrl: "DocCtrl", holder: "Drafter", publisher: "Drafter", owner: "Viewer", reviewer: "Engineer-1", outsider: "Engineer-2" } as const;
type Member = keyof typeof ROLES;
type Who = Member | "service";

const ids = () => ({
  org: randomUUID(), lib: randomUUID(), project: randomUUID(), link: randomUUID(),
  // dReview: Issued at A, pending 2A in review with a complete signed roster, checked out by the holder
  dReview: randomUUID(), rA: randomUUID(), r2A: randomUUID(),
  // dFree: the same, nobody holds it
  dFree: randomUUID(), fA: randomUUID(), f2A: randomUUID(),
  // dOwn: the same, checked out by the publisher
  dOwn: randomUUID(), oA: randomUUID(), o2A: randomUUID(),
  // dIntake: born through the link, Issued at A, checked out by the holder; pending i2A is the door's
  // genuine submission, named by the intake route's own record
  dIntake: randomUUID(), iA: randomUUID(), i2A: randomUUID(),
  // dForged: born through the link, Issued at A, checked out by the holder; pending x2A is a door-shaped
  // row with NO route record (what a signed-in session could write before 20261247)
  dForged: randomUUID(), xA: randomUUID(), x2A: randomUUID(),
  // dForgedFree: the same, nobody holds it
  dForgedFree: randomUUID(), yA: randomUUID(), y2A: randomUUID(),
  // dDoor: born through the link, Issued at A, checked out by the holder — the door submits to it live
  dDoor: randomUUID(), dA: randomUUID(),
  // REV-37: held documents — dSheet (a recorded split's replacement), dTarget (a merge's target),
  // dStray (named by nothing), dGone (named by a split that was reversed), dSrc (the split's source)
  dSheet: randomUUID(), sA: randomUUID(), dTarget: randomUUID(), tA: randomUUID(), dStray: randomUUID(), zA: randomUUID(),
  dGone: randomUUID(), gA: randomUUID(), dSrc: randomUUID(), cA: randomUUID(),
  evSplit: randomUUID(), evMerge: randomUUID(), evOld: randomUUID(),
  uid: Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomUUID()])) as Record<Member, string>,
});
type World = ReturnType<typeof ids>;

function seed(db: string, w: World): void {
  const u = w.uid;
  const tag = w.org.slice(0, 8);
  const reviewed = (doc: string, a: string, d2: string) => `
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, file_url, change_type, created_by, created_at, supersedes_version_id) VALUES
      ('${d2}', '${w.org}', '${doc}', '2A', 'B', 'in_review', 'p37/${tag}/${d2}.pdf', 'Major', '${u.holder}', now() - interval '1 day', '${a}');
    INSERT INTO e_signatures (id, org_id, resource_type, resource_id, document_version_id, intent, statement, signer_user_id, signer_name)
      VALUES ('${d2.slice(0, 8)}-0000-4000-8000-000000000001'::uuid, '${w.org}', 'document_version', '${d2}', '${d2}', 'Approved', 'I approve', '${u.reviewer}', 'reviewer');
    INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at)
      VALUES ('${d2.slice(0, 8)}-0000-4000-8000-000000000002'::uuid, '${w.org}', '${doc}', '${d2}', '${u.reviewer}', 'primary', true, 'signed', '${d2.slice(0, 8)}-0000-4000-8000-000000000001'::uuid, now());
    UPDATE documents SET pending_version_id = '${d2}' WHERE id = '${doc}';`;
  const external = (doc: string, a: string, d2: string) => `
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by, created_by_name, created_at, supersedes_version_id) VALUES
      ('${d2}', '${w.org}', '${doc}', '2A', 'B', 'in_review', 'external', '${w.link}', 'p37/${tag}/${d2}.pdf', 'Major', '${w.link}', 'Contractor Co', now() - interval '1 day', '${a}');
    UPDATE documents SET pending_version_id = '${d2}' WHERE id = '${doc}';`;
  const docs: Array<[string, string, string]> = [
    [w.dReview, w.rA, "R"], [w.dFree, w.fA, "F"], [w.dOwn, w.oA, "O"], [w.dIntake, w.iA, "I"], [w.dForged, w.xA, "X"],
    [w.dForgedFree, w.yA, "Y"], [w.dDoor, w.dA, "D"], [w.dSheet, w.sA, "S"], [w.dTarget, w.tA, "T"], [w.dStray, w.zA, "Z"],
    [w.dGone, w.gA, "G"], [w.dSrc, w.cA, "C"],
  ];
  admin(db, `
    INSERT INTO orgs (id, name, type) VALUES ('${w.org}', 'P37 ${tag}', 'business');
    ${(Object.keys(ROLES) as Member[]).map((k) => `
    INSERT INTO auth.users (id, email, aud, role) VALUES ('${u[k]}', '${k}-${tag}@p37.test', 'authenticated', 'authenticated');
    INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${u[k]}', '${k}-${tag}@p37.test', '${k}', '${w.org}');
    INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${w.org}', '${u[k]}', '${k}-${tag}@p37.test', '${ROLES[k]}', ARRAY[]::text[], 'active');`).join("")}
    INSERT INTO libraries (id, org_id, name, type, acl_index) VALUES ('${w.lib}', '${w.org}', 'P37', 'documents',
      '{"allow":{"users":{"publish":["${u.holder}", "${u.publisher}"]}}}'::jsonb);
    INSERT INTO documents (id, org_id, library_id, title, document_number, status, owner_user_id) VALUES
      ${docs.map(([id, , k]) => `('${id}', '${w.org}', '${w.lib}', 'Doc ${k}', 'P37-${k}-${tag}', 'Draft', '${u.owner}')`).join(",\n      ")};
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, created_at) VALUES
      ${docs.map(([id, a, k]) => `('${a}', '${w.org}', '${id}', 'A', 'p37/${tag}/${k.toLowerCase()}a.pdf', 'Minor', '${u.holder}', now() - interval '2 days')`).join(",\n      ")};
    ${docs.map(([id, a]) => `UPDATE documents SET current_version_id = '${a}', status = 'Issued', rev = 'A' WHERE id = '${id}';`).join("\n    ")}
    SET session_replication_role = replica;
    ${reviewed(w.dReview, w.rA, w.r2A)}
    ${reviewed(w.dFree, w.fA, w.f2A)}
    ${reviewed(w.dOwn, w.oA, w.o2A)}
    INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${w.project}', '${w.org}', 'P37 project', '${u.owner}', '${u.owner}');
    INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids)
      VALUES ('${w.link}', '${w.org}', '${w.project}', 'Contractor Co', md5('${w.link}') || md5('${w.org}'), now() + interval '30 days', '${u.owner}', ARRAY[]::uuid[]);
    UPDATE documents SET authored_by_link_id = '${w.link}' WHERE id IN ('${w.dIntake}', '${w.dForged}', '${w.dForgedFree}', '${w.dDoor}');
    ${external(w.dIntake, w.iA, w.i2A)}
    ${external(w.dForged, w.xA, w.x2A)}
    ${external(w.dForgedFree, w.yA, w.y2A)}
    -- the intake route's own record of the genuine submission (app/api/intake/upload: the service role, no person named)
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
      VALUES ('INTAKE_SUBMISSION', '${w.dIntake}', 'document', '${w.org}', NULL, jsonb_build_object('versionId', '${w.i2A}', 'company', 'Contractor Co'));
    -- REV-37: the recorded operations a reversal parks under (as the app writes them, by Document Control)
    INSERT INTO audit_logs (id, action, resource_id, resource_type, org_id, user_id, details, "timestamp") VALUES
      ('${w.evSplit}', 'DOC_SPLIT', '${w.dSrc}', 'document', '${w.org}', '${u.docctrl}', jsonb_build_object('priorStatus', 'Issued', 'replacementDocIds', jsonb_build_array('${w.dSheet}')), now() - interval '1 day'),
      ('${w.evMerge}', 'DOC_MERGED', '${w.dSrc}', 'document', '${w.org}', '${u.docctrl}', jsonb_build_object('mergeSiblings', jsonb_build_array('${w.dSrc}'), 'mergedIntoDocumentId', '${w.dTarget}'), now() - interval '1 day'),
      ('${w.evOld}', 'DOC_SPLIT', '${w.dSrc}', 'document', '${w.org}', '${u.docctrl}', jsonb_build_object('priorStatus', 'Issued', 'replacementDocIds', jsonb_build_array('${w.dGone}')), now() - interval '3 days');
    INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details, "timestamp") VALUES
      ('DOC_SPLIT_REVERSED', '${w.dSrc}', 'document', '${w.org}', '${u.docctrl}', jsonb_build_object('reversedAuditEventId', '${w.evOld}'), now() - interval '2 days');
    INSERT INTO document_holds (org_id, document_id, reason, opened_by) VALUES
      ('${w.org}', '${w.dSheet}', 'Other', '${u.docctrl}'), ('${w.org}', '${w.dTarget}', 'Other', '${u.docctrl}'),
      ('${w.org}', '${w.dStray}', 'Other', '${u.docctrl}'), ('${w.org}', '${w.dGone}', 'Other', '${u.docctrl}');
    RESET session_replication_role;
    UPDATE documents SET checked_out_by = '${u.holder}', checked_out_by_name = 'Holder Person', checked_out_at = now()
     WHERE id IN ('${w.dReview}', '${w.dIntake}', '${w.dForged}', '${w.dDoor}');
    UPDATE documents SET checked_out_by = '${u.publisher}', checked_out_by_name = 'Publisher Person', checked_out_at = now()
     WHERE id = '${w.dOwn}';`);
}

/** Statements as `who`, each its own savepointed call (a sequence of PostgREST requests), in ONE
 *  transaction that is rolled back. `prelude` runs first as the superuser; `after` reads what was written. */
function probeSeq(db: string, w: World, who: Who, stmts: string[], after?: string, prelude = ""): { out: string; stderr: string } {
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
  return { out: r.stdout.split("\n").filter((l) => l.length > 0).slice(1).join(" / "), stderr: r.stderr };
}

/** The three-step PATCH's promote, as promoteThreeStep sends it — here sent by hand. */
const threeStep = (doc: string, pend: string, cur: string) =>
  `UPDATE documents SET current_version_id = '${pend}', rev = 'B', revision = 'B', status = 'Issued', pending_version_id = NULL
    WHERE id = '${doc}' AND pending_version_id = '${pend}' AND current_version_id = '${cur}'`;
const finalize = (doc: string, pend: string, cur: string, answer = "promoted") =>
  `SELECT 1 WHERE finalize_reviewed_promote('${doc}', '${pend}', '${cur}', 'B', NULL) = '${answer}'`;
const reporting = (doc: string, pend: string, cur: string, answer: string) =>
  `SELECT 1 WHERE finalize_reviewed_promote(p_document_id => '${doc}', p_pending_id => '${pend}', p_expected_current => '${cur}', p_base_rev => 'B', p_actor => NULL, p_report_over_checkout => true) = '${answer}'`;
/** What the write left: the pointer | the records (all) | of those, the guard's (promote direct_write) | the holder's notices. */
const left = (w: World, doc: string, holder = w.uid.holder) => `SELECT
  (SELECT COALESCE(current_version_id::text, 'none') FROM documents WHERE id = '${doc}') || '|' ||
  (SELECT count(*) FROM audit_logs WHERE resource_id = '${doc}' AND action = 'REVIEW_PROMOTED_OVER_CHECKOUT') || '|' ||
  (SELECT count(*) FROM audit_logs WHERE resource_id = '${doc}' AND action = 'REVIEW_PROMOTED_OVER_CHECKOUT' AND details->>'promote' = 'direct_write') || '|' ||
  (SELECT count(*) FROM notifications WHERE resource_id = '${doc}' AND kind = 'revision_published_over_checkout' AND user_id = '${holder}');`;
const recordOf = (doc: string) => `SELECT COALESCE(user_id::text, 'none') || '|' || COALESCE(user_email, 'none') || '|' || (details->>'via') || '|' || COALESCE(details->>'promote', 'none') || '|' ||
  (details->>'holderUserId') || '|' || (details->>'holderName') || '|' || (details->>'versionId') || '|' || (details->>'previousVersionId') || '|' || (details->>'revisionLabel') || '|' || (details->>'holderNotified')
  FROM audit_logs WHERE resource_id = '${doc}' AND action = 'REVIEW_PROMOTED_OVER_CHECKOUT';`;
const noticeOf = (doc: string) => `SELECT COALESCE(actor_user_id::text, 'none') || '|' || title || '|' || body || '|' || link || '|' || resource_type || '|' || (metadata->>'via') || '|' || (metadata->>'newRev')
  FROM notifications WHERE resource_id = '${doc}' AND kind = 'revision_published_over_checkout';`;
const REFUSE_FN = "CREATE OR REPLACE FUNCTION public.p37_refuse() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'p37 refused'; END $f$;";
const refuse = (...tables: string[]) => [REFUSE_FN, ...tables.map((t) => `CREATE TRIGGER p37_refuse_${t} BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION public.p37_refuse();`)].join("\n");

describe.skipIf(skip !== null)("DCK-18 / REV-37 (20261254): door (b) guarded and recorded, the park bound, the hold-override record railed", () => {
  let w: World;
  beforeAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${AFTER}`);
    admin(BEFORE, UNDO_254);
    w = ids();
    seed(BEFORE, w);
    seed(AFTER, w);
  });
  afterAll(() => { admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`); });

  const both = (who: Who, stmts: string[], after?: string, prelude = "") =>
    ({ before: probeSeq(BEFORE, w, who, stmts, after, prelude).out, after: probeSeq(AFTER, w, who, stmts, after, prelude).out });

  it("the two sides are what they say: the replay carries the P37 limbs, the rail and the finalize flag; the copy carries none of them", () => {
    const has = (db: string) => admin(db, `SELECT
      (SELECT prosrc LIKE '%INTAKE_SUBMISSION%app.review_promote_records%' FROM pg_proc WHERE proname = 'enforce_document_publish_guard') || '|' ||
      (SELECT prosrc LIKE '%app.review_promote_records%' FROM pg_proc WHERE proname = 'finalize_reviewed_promote') || '|' ||
      (SELECT prosrc LIKE '%DOC_SPLIT_REVERSED%' FROM pg_proc WHERE proname = 'retire_over_hold') || '|' ||
      (SELECT prosrc LIKE '%INTAKE_DOOR_SUBMITTED%' FROM pg_proc WHERE proname = 'intake_door_submit_version') || '|' ||
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_audit_logs_hold_override_rail')`);
    expect(has(AFTER)).toBe("true|true|true|true|true");
    expect(has(BEFORE)).toBe("false|false|false|false|false");
  });

  describe("DCK-18 (a) — the hand-sent three-step promote over another person's checkout, recorded and told by the guard", () => {
    it("THE DEFECT, closed: a publisher's hand-sent three-step PATCH of the reviewed 2A over the holder's checkout lands on both sides — before, nobody is told and nothing records it; after, ONE record and ONE notice, the guard's", () => {
      const r = both("publisher", [threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(r.before).toBe(`ok:1 / ${w.r2A}|0|0|0`);
      expect(r.after).toBe(`ok:1 / ${w.r2A}|1|1|1`);
      const tag = w.org.slice(0, 8);
      expect(probeSeq(AFTER, w, "publisher", [threeStep(w.dReview, w.r2A, w.rA)], recordOf(w.dReview)).out)
        .toBe(`ok:1 / ${w.uid.publisher}|publisher-${tag}@p37.test|database|direct_write|${w.uid.holder}|Holder Person|${w.r2A}|${w.rA}|B|true`);
      expect(probeSeq(AFTER, w, "publisher", [threeStep(w.dReview, w.r2A, w.rA)], noticeOf(w.dReview)).out)
        .toBe(`ok:1 / ${w.uid.publisher}|Reviewed Rev B published while you're checked out|publisher-${tag}@p37.test published the reviewed revision (reviewed as 2A). Your checkout stays open — check your work against Rev B before you publish.|/documents/${w.lib}?doc=${w.dReview}|document|database|B`);
    });

    it("the same for Document Control, and for a genuine intake submission's three-step (no roster; named by the route's record)", () => {
      const d = both("docctrl", [threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(d.before).toBe(`ok:1 / ${w.r2A}|0|0|0`);
      expect(d.after).toBe(`ok:1 / ${w.r2A}|1|1|1`);
      const i = both("publisher", [threeStep(w.dIntake, w.i2A, w.iA)], left(w, w.dIntake));
      expect(i.before).toBe(`ok:1 / ${w.i2A}|0|0|0`);
      expect(i.after).toBe(`ok:1 / ${w.i2A}|1|1|1`);
    });

    it("NO DOUBLE RECORD: finalize_reviewed_promote over the checkout writes its own record and notice (20261252) and the guard writes none — exactly one of each on both sides; the reporting call still answers what the function wrote", () => {
      const r = both("publisher", [finalize(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(r.before).toBe(`ok:1 / ${w.r2A}|1|0|1`);
      expect(r.after).toBe(r.before);
      const rep = both("publisher", [reporting(w.dReview, w.r2A, w.rA, "promoted_over_checkout_recorded_told")], left(w, w.dReview));
      expect(rep.after).toBe(`ok:1 / ${w.r2A}|1|0|1`);
      expect(rep.after).toBe(rep.before);
      // the Intake tab's approve of the genuine submission, the same
      const i = both("publisher", [finalize(w.dIntake, w.i2A, w.iA)], left(w, w.dIntake));
      expect(i.before).toBe(`ok:1 / ${w.i2A}|1|0|1`);
      expect(i.after).toBe(i.before);
    });

    it("the finalize flag reaches only finalize's own statement: a three-step PATCH sent after a finalize of ANOTHER document in the same transaction is still recorded by the guard", () => {
      const r = both("publisher", [finalize(w.dFree, w.f2A, w.fA), threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(r.before).toBe(`ok:1 / ok:1 / ${w.r2A}|0|0|0`);
      expect(r.after).toBe(`ok:1 / ok:1 / ${w.r2A}|1|1|1`);
    });

    it("REGRESSION: the holder's own three-step and an unlocked document's are no pass — landed on both sides, nothing written", () => {
      const own = both("publisher", [threeStep(w.dOwn, w.o2A, w.oA)], left(w, w.dOwn, w.uid.publisher));
      expect(own.before).toBe(`ok:1 / ${w.o2A}|0|0|0`);
      expect(own.after).toBe(own.before);
      const free = both("publisher", [threeStep(w.dFree, w.f2A, w.fA)], left(w, w.dFree));
      expect(free.before).toBe(`ok:1 / ${w.f2A}|0|0|0`);
      expect(free.after).toBe(free.before);
    });

    it("REGRESSION: publish_revision's own promote over the checkout (door (a): the publisher's override with its reason) lands on both sides and records REV_LOCK_OVERRIDDEN — never a door-(b) record", () => {
      const stmt = `SELECT 1 FROM (SELECT publish_revision(p_doc := '${w.dReview}', p_expected_base := '${w.rA}', p_op_class := 'content',
         p_version := '{"revision_label":"C","file_url":"p37/c.pdf","change_type":"Minor","change_log":"p37"}'::jsonb,
         p_actor := NULL, p_override_lock := true, p_override_reason := 'field fix needed today') AS r) x WHERE x.r->>'status' = 'published'`;
      const after = `SELECT (SELECT revision_label FROM document_versions WHERE id = d.current_version_id) || '|' ||
        (SELECT count(*) FROM audit_logs a WHERE a.resource_id = d.id::text AND a.action = 'REV_LOCK_OVERRIDDEN') || '|' ||
        (SELECT count(*) FROM audit_logs a WHERE a.resource_id = d.id::text AND a.action = 'REVIEW_PROMOTED_OVER_CHECKOUT')
        FROM documents d WHERE d.id = '${w.dReview}';`;
      const r = both("publisher", [stmt], after);
      expect(r.before).toBe("ok:1 / C|1|0");
      expect(r.after).toBe(r.before);
    });

    it("a write refused AFTER the record (the publisher tier: a member with no publish authority) leaves nothing — the refusal on both sides, no record, no notice", () => {
      const r = both("reviewer", [threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(r.before).toMatch(new RegExp(`^err:[0-9A-Z]{5}:.* / ${w.rA}\\|0\\|0\\|0$`));
      expect(r.after).toMatch(new RegExp(`^err:[0-9A-Z]{5}:.* / ${w.rA}\\|0\\|0\\|0$`));
    });

    it("FAIL-SAFE: a notice or a record that cannot be written never refuses the write — it lands, a WARNING names what is missing, and the record says whether the holder was told", () => {
      const noNotice = probeSeq(AFTER, w, "publisher", [threeStep(w.dReview, w.r2A, w.rA)], `${left(w, w.dReview)} ${recordOf(w.dReview)}`, refuse("notifications"));
      expect(noNotice.out).toMatch(new RegExp(`^ok:1 / ${w.r2A}\\|1\\|1\\|0 / .*\\|false$`));
      expect(noNotice.stderr).toContain("their notice was not written (the write stands): p37 refused");
      const noRecord = probeSeq(AFTER, w, "publisher", [threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview), refuse("audit_logs"));
      expect(noRecord.out).toBe(`ok:1 / ${w.r2A}|0|0|1`);
      expect(noRecord.stderr).toContain("the record was not written (the write stands): p37 refused");
      const neither = probeSeq(AFTER, w, "publisher", [threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview), refuse("notifications", "audit_logs"));
      expect(neither.out).toBe(`ok:1 / ${w.r2A}|0|0|0`);
    });

    it("a holder who is no longer an active member is not sent a notice (the insert rail skips the row); the pass is still recorded, holderNotified false", () => {
      const gone = `UPDATE org_members SET status = 'suspended' WHERE org_id = '${w.org}' AND uid = '${w.uid.holder}';`;
      const r = probeSeq(AFTER, w, "publisher", [threeStep(w.dReview, w.r2A, w.rA)], `${left(w, w.dReview)} ${recordOf(w.dReview)}`, gone);
      expect(r.out).toMatch(new RegExp(`^ok:1 / ${w.r2A}\\|1\\|1\\|0 / .*\\|false$`));
    });

    it("the service role's write is not judged (returned at the top, as always) — landed on both sides, nothing written by the guard", () => {
      const r = both("service", [threeStep(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(r.before).toBe(`ok:1 / ${w.r2A}|0|0|0`);
      expect(r.after).toBe(r.before);
    });
  });

  describe("DCK-18 (b) — door (b)'s intake limb trusts only a submission the intake route recorded", () => {
    it("THE DEFECT, closed: a pre-paste door-shaped submission with NO route record, promoted over the holder's checkout — finalize (the Intake tab's approve) and the three-step — landed before; after, refused 42501 in the lock leg's words, nothing moved, nothing recorded", () => {
      for (const stmt of [finalize(w.dForged, w.x2A, w.xA), threeStep(w.dForged, w.x2A, w.xA)]) {
        const r = both("publisher", [stmt], left(w, w.dForged));
        expect(r.before).toMatch(new RegExp(`^ok:1 / ${w.x2A}\\|`));
        expect(r.after).toMatch(new RegExp(`^err:42501:This document is checked out by Holder Person, so a new revision can't be made current here;.* / ${w.xA}\\|0\\|0\\|0$`));
      }
      // Document Control too (the lock leg binds every tier)
      const d = both("docctrl", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged));
      expect(d.after).toMatch(new RegExp(`^err:42501:.* / ${w.xA}\\|0\\|0\\|0$`));
    });

    it("a route record that names ANOTHER version, comes from a person, or sits in another workspace vouches for nothing", () => {
      const other = `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_SUBMISSION', '${w.dForged}', 'document', '${w.org}', NULL, jsonb_build_object('versionId', '${w.i2A}'));`;
      const person = `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_SUBMISSION', '${w.dForged}', 'document', '${w.org}', '${w.uid.publisher}', jsonb_build_object('versionId', '${w.x2A}'));`;
      const elsewhere = `INSERT INTO orgs (id, name, type) VALUES ('${w.project}', 'other', 'business'); INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_SUBMISSION', '${w.dForged}', 'document', '${w.project}', NULL, jsonb_build_object('versionId', '${w.x2A}'));`;
      for (const prelude of [other, person, elsewhere]) {
        expect(probeSeq(AFTER, w, "publisher", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged), prelude).out).toMatch(/^err:42501:/);
      }
      // and the route's own record does (the same row the route writes, as the service role)
      const route = `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_SUBMISSION', '${w.dForged}', 'document', '${w.org}', NULL, jsonb_build_object('versionId', '${w.x2A}'));`;
      expect(probeSeq(AFTER, w, "publisher", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged), route).out).toBe(`ok:1 / ${w.x2A}|1|0|1`);
    });

    it("a signed-in session cannot write the route's record: an INTAKE_SUBMISSION row with no person named is refused by audit_logs_insert, on both sides", () => {
      const ins = `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_SUBMISSION', '${w.dForged}', 'document', '${w.org}', NULL, jsonb_build_object('versionId', '${w.x2A}'))`;
      const r = both("publisher", [ins]);
      expect(r.before).toMatch(/^err:42501:/);
      expect(r.after).toMatch(/^err:42501:/);
    });

    it("REGRESSION: the genuine submission (the route's record) promotes over the holder's checkout on both sides — finalize and the three-step", () => {
      const f = both("publisher", [finalize(w.dIntake, w.i2A, w.iA)], left(w, w.dIntake));
      expect(f.before).toBe(`ok:1 / ${w.i2A}|1|0|1`);
      expect(f.after).toBe(f.before);
      const t = both("publisher", [threeStep(w.dIntake, w.i2A, w.iA)], left(w, w.dIntake));
      expect(t.before).toBe(`ok:1 / ${w.i2A}|0|0|0`);
      expect(t.after).toBe(`ok:1 / ${w.i2A}|1|1|1`);
    });

    it("REGRESSION: with no checkout, or for the holder themselves, the unrecorded door-shaped row is no lock question — promoted on both sides (Document Control retires a stray one from the Inspector or the Intake tab)", () => {
      const free = both("publisher", [finalize(w.dForgedFree, w.y2A, w.yA)], left(w, w.dForgedFree));
      expect(free.before).toBe(`ok:1 / ${w.y2A}|0|0|0`);
      expect(free.after).toBe(free.before);
      const holder = both("holder", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged));
      expect(holder.before).toBe(`ok:1 / ${w.x2A}|0|0|0`);
      expect(holder.after).toBe(holder.before);
    });

    it("REGRESSION: a reviewed roster's promote over the checkout (the roster limb) needs no route record — promoted on both sides", () => {
      const r = both("publisher", [finalize(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
      expect(r.before).toBe(`ok:1 / ${w.r2A}|1|0|1`);
      expect(r.after).toBe(r.before);
    });

    // Both of the contractor door's paths, live: the route (the service role) submits through
    // intake_door_submit_version, points the document's pending pointer at the new row and writes its
    // INTAKE_SUBMISSION record; a publisher then approves it over the holder's checkout.
    const doorThenApprove = (db: string, label: string, opts: { gap?: boolean; record?: boolean; refuseDoorRecord?: boolean }) => {
      const { conn } = mosDb();
      const hash = admin(db, `SELECT token_hash FROM project_intake_links WHERE id = '${w.link}'`);
      const row = `(SELECT id FROM document_versions WHERE record_id = '${w.dDoor}' AND revision_label = '${label}')`;
      const service = JSON.stringify({ role: "service_role" });
      const publisher = JSON.stringify({ role: "authenticated", sub: w.uid.publisher });
      const sql = [
        "BEGIN;",
        "ALTER TABLE document_versions ALTER COLUMN created_by DROP NOT NULL;",
        ...(opts.gap ? ["CREATE POLICY p37_readiness_gap ON document_versions AS RESTRICTIVE FOR INSERT WITH CHECK (true);"] : []),
        ...(opts.refuseDoorRecord ? [
          "CREATE OR REPLACE FUNCTION public.p37_refuse_door() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'p37 refused'; END $f$;",
          "CREATE TRIGGER p37_refuse_door BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.action = 'INTAKE_DOOR_SUBMITTED') EXECUTE FUNCTION public.p37_refuse_door();",
        ] : []),
        "SET LOCAL ROLE service_role;",
        `SELECT set_config('request.jwt.claims', ${dollarQuote(service)}, true);`,
        "SELECT 'ready:' || intake_door_version_rls_ready();",
        `SELECT harness.try_sql(${dollarQuote(`SELECT 1 WHERE intake_door_submit_version('${hash}', jsonb_build_object(
          'record_id', '${w.dDoor}', 'revision_label', '${label}', 'file_url', 'orgs/${w.org}/project-intake/${w.project}/door-${label}.pdf',
          'created_by_name', 'Contractor Co', 'supersedes_version_id', '${w.dA}')) IS NOT NULL`)});`,
        `SELECT harness.try_sql(${dollarQuote(`UPDATE documents SET pending_version_id = ${row} WHERE id = '${w.dDoor}'`)});`,
        ...(opts.record ? [`SELECT harness.try_sql(${dollarQuote(`INSERT INTO audit_logs (action, resource_type, resource_id, org_id, user_id, user_email, details)
          SELECT 'INTAKE_SUBMISSION', 'document', '${w.dDoor}', '${w.org}', NULL, 'contact@contractor.test', jsonb_build_object('versionId', ${row}, 'company', 'Contractor Co')`)});`] : []),
        `SELECT 'as:publisher' WHERE set_config('request.jwt.claims', ${dollarQuote(publisher)}, true) IS NOT NULL;`,
        "SET LOCAL ROLE authenticated;",
        // the door's row carries no base revision, so the approve names its own label (the label rule's match)
        `SELECT harness.try_sql(${dollarQuote(`SELECT 1 WHERE finalize_reviewed_promote('${w.dDoor}', ${row}, '${w.dA}', '${label}', NULL) = 'promoted'`)});`,
        "RESET ROLE;",
        `SELECT 'current:' || (current_version_id = ${row}) FROM documents WHERE id = '${w.dDoor}';`,
        // the door's own record of the submission: how many, whether it names no person, and which path inserted it
        `SELECT 'door:' || count(*) || '|' || COALESCE(string_agg((user_id IS NULL)::text || ',' || (details->>'insertedAs') || ',' || (details->>'via'), ';'), 'none')
           FROM audit_logs WHERE action = 'INTAKE_DOOR_SUBMITTED' AND resource_id = '${w.dDoor}' AND org_id = '${w.org}' AND details->>'versionId' = ${row}::text;`,
        "ROLLBACK;",
      ].join("\n");
      const r = runPsql(conn!, db, conn!.superuser, { sql });
      if (!r.ok) throw new Error(`door then approve failed on ${db}: ${r.error ?? r.stderr}`);
      return { out: r.stdout.split("\n").filter((l) => l.length > 0).slice(1).join(" / "), stderr: r.stderr };
    };
    const door = (db: string, label: string, opts: { gap?: boolean; record?: boolean; refuseDoorRecord?: boolean }) => doorThenApprove(db, label, opts).out;

    it("REGRESSION, both door paths: a submission filed through the contractor door's ROLE SWITCH and through its BOUND-CLAIMS fallback, recorded by the route, is approved over the holder's checkout on both sides — and after, the door has recorded it itself, no person named, naming the path", () => {
      expect(door(BEFORE, "5A", { record: true }), "before role switch").toBe("ready:true / ok:1 / ok:1 / ok:1 / as:publisher / ok:1 / current:true / door:0|none");
      expect(door(BEFORE, "5B", { record: true, gap: true }), "before bound claims").toBe("ready:false / ok:1 / ok:1 / ok:1 / as:publisher / ok:1 / current:true / door:0|none");
      expect(door(AFTER, "5A", { record: true }), "after role switch").toBe("ready:true / ok:1 / ok:1 / ok:1 / as:publisher / ok:1 / current:true / door:1|true,intake_door,intake_door_submit_version");
      expect(door(AFTER, "5B", { record: true, gap: true }), "after bound claims").toBe("ready:false / ok:1 / ok:1 / ok:1 / as:publisher / ok:1 / current:true / door:1|true,bound_identity,intake_door_submit_version");
    });

    it("THE REGRESSION, closed (the integrator's ruling (1)): a genuine submission whose route-side record write FAILED is still approved over the holder's checkout — both door paths, on both sides (after, the door's own record vouches for it)", () => {
      for (const db of [BEFORE, AFTER]) {
        const sw = door(db, "5C", {});
        const bc = door(db, "5D", { gap: true });
        expect(sw, `${db} role switch`).toMatch(/^ready:true \/ ok:1 \/ ok:1 \/ as:publisher \/ ok:1 \/ current:true \/ door:/);
        expect(bc, `${db} bound claims`).toMatch(/^ready:false \/ ok:1 \/ ok:1 \/ as:publisher \/ ok:1 \/ current:true \/ door:/);
      }
    });

    it("FAIL-SAFE: the door's own record that cannot be written never refuses the submission — it lands (a WARNING names what is missing); then the route's record vouches, and with neither the approve over a checkout is refused (the holder checks in first) — the fail-safe direction", () => {
      const lost = doorThenApprove(AFTER, "5E", { refuseDoorRecord: true });
      expect(lost.out).toMatch(/^ready:true \/ ok:1 \/ ok:1 \/ as:publisher \/ err:42501:This document is checked out by Holder Person.* \/ current:false \/ door:0\|none$/);
      expect(lost.stderr).toContain("the door's own record of it was not written (the submission stands): p37 refused");
      expect(door(AFTER, "5F", { refuseDoorRecord: true, record: true })).toBe("ready:true / ok:1 / ok:1 / ok:1 / as:publisher / ok:1 / current:true / door:0|none");
      expect(door(AFTER, "5G", { refuseDoorRecord: true, gap: true })).toMatch(/^ready:false \/ ok:1 \/ ok:1 \/ as:publisher \/ err:42501:.* \/ current:false \/ door:0\|none$/);
    });

    // the route's INTAKE_SUBMISSION record kept in the EVID-6 outbox (lib/auditOutbox.ts's server path, as the
    // service role: source 'server', no reporter), and the same row as the maintenance cron drains it
    // (lib/auditOutboxDrain.ts drainedAuditRow: AUDIT_DEAD_LETTER, typed org, the lost row as sent)
    const lostRow = (versionId: string, userId = "null") => `jsonb_build_object('action', 'INTAKE_SUBMISSION', 'resource_id', '${w.dForged}', 'resource_type', 'document',
      'org_id', '${w.org}', 'user_id', ${userId}, 'user_email', 'contact@contractor.test', 'user_role', null,
      'details', jsonb_build_object('versionId', '${versionId}', 'company', 'Contractor Co'), 'metadata', null)`;
    const outbox = (o: { source?: string; reporter?: string | null; versionId?: string; userId?: string } = {}) => `INSERT INTO audit_dead_letters (org_id, action, entry, error, source, reported_by)
      VALUES ('${w.org}', 'INTAKE_SUBMISSION', jsonb_build_object('row', ${lostRow(o.versionId ?? w.x2A, o.userId)}, 'reporter', null), 'fetch failed',
              '${o.source ?? "server"}', ${o.reporter ? `'${o.reporter}'` : "NULL"});`;
    const drained = (o: { source?: string; reporter?: string | null; versionId?: string } = {}) => `INSERT INTO audit_logs (id, action, resource_type, resource_id, org_id, user_id, user_email, user_role, details)
      VALUES (gen_random_uuid(), 'AUDIT_DEAD_LETTER', 'org', '${w.org}', '${w.org}', NULL, 'system:audit-outbox', 'system',
              jsonb_build_object('outboxId', gen_random_uuid(), 'lostAction', 'INTAKE_SUBMISSION', 'lost', ${lostRow(o.versionId ?? w.x2A)} || '{"asSent": true}'::jsonb,
                                 'reportedBy', ${o.reporter ? `'${o.reporter}'` : "NULL"}, 'reporter', NULL, 'source', '${o.source ?? "server"}', 'error', 'fetch failed', 'reportedAt', now()));`;

    it("the route's record lost and kept in the EVID-6 outbox (P37 final fix pass): a server dead letter vouches — still in the outbox, or drained into the trail — and the submission is approved over the checkout", () => {
      expect(probeSeq(AFTER, w, "publisher", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged), outbox()).out).toBe(`ok:1 / ${w.x2A}|1|0|1`);
      expect(probeSeq(AFTER, w, "publisher", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged), drained()).out).toBe(`ok:1 / ${w.x2A}|1|0|1`);
      expect(probeSeq(AFTER, w, "publisher", [threeStep(w.dForged, w.x2A, w.xA)], left(w, w.dForged), outbox()).out).toBe(`ok:1 / ${w.x2A}|1|1|1`);
    });

    it("a dead letter vouches for nothing when a member reported it (the browser route: source 'browser', its reporter named), when it names another version or a person, or when the outbox is not there (refused in the lock leg's words, never an error of its own)", () => {
      const refused = /^err:42501:This document is checked out by Holder Person/;
      for (const prelude of [
        outbox({ source: "browser", reporter: w.uid.publisher }),
        outbox({ reporter: w.uid.publisher }),
        outbox({ versionId: w.i2A }),
        outbox({ userId: `'${w.uid.publisher}'` }),
        drained({ source: "browser", reporter: w.uid.publisher }),
        drained({ versionId: w.i2A }),
        "DROP TABLE audit_dead_letters CASCADE;",
      ]) {
        expect(probeSeq(AFTER, w, "publisher", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged), prelude).out, prelude.slice(0, 120)).toMatch(refused);
      }
    });

    it("a signed-in session cannot write the door's own record either: an INTAKE_DOOR_SUBMITTED row with no person named is refused by audit_logs_insert; one naming the member vouches for nothing", () => {
      const ins = (uid: string) => `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_DOOR_SUBMITTED', '${w.dForged}', 'document', '${w.org}', ${uid}, jsonb_build_object('versionId', '${w.x2A}'))`;
      expect(probeSeq(AFTER, w, "publisher", [ins("NULL")]).out).toMatch(/^err:42501:/);
      expect(probeSeq(AFTER, w, "publisher", [ins(`'${w.uid.publisher}'`), finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged)).out).toMatch(/^ok:1 \/ err:42501:This document is checked out by Holder Person/);
      // the service role's (the door's) does
      const svc = `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('INTAKE_DOOR_SUBMITTED', '${w.dForged}', 'document', '${w.org}', NULL, jsonb_build_object('versionId', '${w.x2A}'));`;
      expect(probeSeq(AFTER, w, "publisher", [finalize(w.dForged, w.x2A, w.xA)], left(w, w.dForged), svc).out).toBe(`ok:1 / ${w.x2A}|1|0|1`);
    });
  });

  describe("REV-37 (1) — retire_over_hold's recorded park bound to the reversal being run", () => {
    const park = (doc: string, answer = "superseded_over_hold") =>
      `SELECT 1 FROM (SELECT retire_over_hold('${doc}', 'reversal_park', 'Reverted split — wrong sheets', now(), NULL, true) AS r) x WHERE x.r = '${answer}'`;
    const statusOf = (doc: string) => `SELECT status || '|' || (SELECT count(*) FROM audit_logs a WHERE a.resource_id = '${doc}' AND a.action = 'REV_HOLD_OVERRIDDEN') FROM documents WHERE id = '${doc}';`;

    it("REGRESSION: the park of a held sheet a recorded split names among its replacements, and of a held merge target, is the recorded pass on both sides", () => {
      for (const doc of [w.dSheet, w.dTarget]) {
        const r = both("docctrl", [park(doc)], statusOf(doc));
        expect(r.before, doc).toBe("ok:1 / Superseded|1");
        expect(r.after, doc).toBe(r.before);
      }
    });

    it("THE DEFECT, closed: Document Control's recorded park of a held document no recorded split or merge names — or one whose split was reversed — passed before; after, refused 42501, nothing changed, nothing recorded", () => {
      for (const doc of [w.dStray, w.dGone]) {
        const r = both("docctrl", [park(doc)], statusOf(doc));
        expect(r.before, doc).toBe("ok:1 / Superseded|1");
        expect(r.after, doc).toMatch(/^err:42501:retire_over_hold: a reversal parks a held document only when a recorded split names it .* \/ Issued\|0$/);
      }
    });

    it("REGRESSION: the split / merge source flip over a hold stays the recorded Document Control pass (the integrator's ruling — its evidence is written after the flip); an unheld park and an unforced call are the bare write, as before", () => {
      for (const via of ["split", "merge"]) {
        const r = both("docctrl", [`SELECT 1 FROM (SELECT retire_over_hold('${w.dStray}', '${via}', 'replaced', now(), NULL, true) AS r) x WHERE x.r = 'superseded_over_hold'`], statusOf(w.dStray));
        expect(r.before, via).toBe("ok:1 / Superseded|1");
        expect(r.after, via).toBe(r.before);
      }
      const unheld = both("docctrl", [park(w.dFree, "superseded")], statusOf(w.dFree));
      expect(unheld.before).toBe("ok:1 / Superseded|0");
      expect(unheld.after).toBe(unheld.before);
      const unforced = both("docctrl", [`SELECT retire_over_hold('${w.dStray}', 'reversal_park', 'x', now(), NULL, false)`], statusOf(w.dStray));
      expect(unforced.before).toMatch(/^err:23514:Document has an active hold; a held document can't be superseded or voided here/);
      expect(unforced.after).toBe(unforced.before);
    });
  });

  describe("REV-37 (2) — the REV_HOLD_OVERRIDDEN write rail", () => {
    const forged = (doc: string, via = "reversal_restore") => `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
      VALUES ('REV_HOLD_OVERRIDDEN', '${doc}', 'document', '${w.org}', '${w.uid.docctrl}', jsonb_build_object('via', '${via}', 'reversedAuditEventId', '${w.evSplit}', 'newStatus', 'Issued'))`;
    const count = (doc: string) => `SELECT count(*) FROM audit_logs WHERE resource_id = '${doc}' AND action = 'REV_HOLD_OVERRIDDEN';`;

    it("THE DEFECT, closed: a member's own REV_HOLD_OVERRIDDEN row (their user_id, their workspace), written on its own, was admitted before; after, refused 42501 — Document Control and a publisher alike", () => {
      for (const who of ["docctrl", "publisher"] as const) {
        const ins = forged(w.dStray).replace(`'${w.uid.docctrl}', jsonb`, `'${w.uid[who]}', jsonb`);
        const r = both(who, [ins], count(w.dStray));
        expect(r.before, who).toBe("ok:1 / 1");
        expect(r.after, who).toMatch(/^err:42501:A hold-override record \(REV_HOLD_OVERRIDDEN\) is written only by the database function .* \/ 0$/);
      }
    });

    it("the forgery chain REV-37 names, closed for a row written from the paste on (a row written before it is the accepted residual — inventory row 5): Document Control writes the reversal's restore record by hand, then re-supersedes a held document through the reversal-rollback door — before, the rollback landed on the forged evidence; after, the forged row is refused and so is the rollback (42501), the document unchanged", () => {
      const rollback = `SELECT put_back_retired_issue('${w.dStray}', 'Superseded', 'reversal_rollback', 'x', true, now(), '${w.uid.docctrl}', 'forged', NULL)`;
      const r = both("docctrl", [forged(w.dStray), rollback], `SELECT status FROM documents WHERE id = '${w.dStray}';`);
      expect(r.before).toBe("ok:1 / ok:1 / Superseded");
      expect(r.after).toMatch(/^err:42501:.* \/ err:42501:put_back_retired_issue: a reversal's rollback re-supersedes a held document only after .* \/ Issued$/);
    });

    it("REGRESSION, every legitimate writer: retire_over_hold's recorded pass, finalize_reviewed_promote's force past a hold, put_back_retired_issue's forced un-archive, restore_reversed_source's restore and the rollback that re-supersedes on its own record — each records on both sides", () => {
      // retire_over_hold (the merge target's park)
      const ret = both("docctrl", [`SELECT retire_over_hold('${w.dTarget}', 'reversal_park', 'x', now(), NULL, true)`], count(w.dTarget));
      expect(ret.before).toBe("ok:1 / 1");
      expect(ret.after).toBe(ret.before);
      // finalize_reviewed_promote's recorded force over a hold (Document Control) — dFree's reviewed 2A, held for the probe
      const hold = `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by) VALUES ('${w.org}', '${w.dFree}', 'Other', 'p37 probe hold', '${w.uid.docctrl}');`;
      const fin = both("docctrl", [`SELECT 1 WHERE finalize_reviewed_promote('${w.dFree}', '${w.f2A}', '${w.fA}', 'B', NULL, true, 'over the hold') = 'promoted'`], count(w.dFree), hold);
      expect(fin.before).toBe("ok:1 / 1");
      expect(fin.after).toBe(fin.before);
      // put_back_retired_issue's forced un-archive over a hold (the stamped put-back)
      const arch = both("docctrl", [
        `UPDATE documents SET status = 'Archived', archived_at = now(), archive_reason = 'p37' WHERE id = '${w.dFree}'`,
        `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by) VALUES ('${w.org}', '${w.dFree}', 'Other', 'p37 probe hold', '${w.uid.docctrl}')`,
        `SELECT 1 WHERE put_back_retired_issue('${w.dFree}', 'Issued', 'unarchive', 'restore', true) = 'restored_over_hold'`,
      ], `SELECT status || '|' || (${count(w.dFree).replace(/;$/, "")}) FROM documents WHERE id = '${w.dFree}';`);
      expect(arch.before).toBe("ok:1 / ok:1 / ok:1 / Issued|1");
      expect(arch.after).toBe(arch.before);
      // restore_reversed_source then the reversal's own rollback (the P36 chain): the source of the split, superseded and held
      const prep = `SET session_replication_role = replica;
        UPDATE documents SET status = 'Superseded', superseded_at = now() - interval '1 day', superseded_by_user = '${w.uid.docctrl}', retired_issue_status = 'Issued', retired_issue_version_id = '${w.cA}' WHERE id = '${w.dSrc}';
        INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by) VALUES ('${w.org}', '${w.dSrc}', 'Other', 'p37 probe hold', '${w.uid.docctrl}');
        RESET session_replication_role;`;
      const chain = both("docctrl", [
        `SELECT restore_reversed_source('${w.dSrc}', 'Issued', '${w.evSplit}', 'reverse it')`,
        `SELECT put_back_retired_issue('${w.dSrc}', 'Superseded', 'reversal_rollback', 'rolled back', true, now(), '${w.uid.docctrl}', 'rolled back', NULL)`,
      ], `SELECT status || '|' || (${count(w.dSrc).replace(/;$/, "")}) FROM documents WHERE id = '${w.dSrc}';`, prep);
      expect(chain.before).toBe("ok:1 / ok:1 / Superseded|2");
      expect(chain.after).toBe(chain.before);
    });

    it("REGRESSION (P37 fix pass), publish_revision — the fifth writer: Document Control's forced publish over a hold AND its forced BRANCH over a hold (which writes the version and its branch row, never the documents row) each publish and record on both sides", () => {
      const pub = (branch: boolean) => `SELECT 1 WHERE (publish_revision(p_doc := '${w.dStray}', p_expected_base := '${w.zA}', p_op_class := 'content',
        p_version := '{"revision_label":"B","file_url":"p37/branch-probe.pdf","change_type":"Minor","change_log":"p37 probe"}'::jsonb,
        p_actor := '${w.uid.docctrl}', p_force := true, p_as_branch := ${branch}, p_branch_reason := 'p37 branch over the hold'))->>'status' = '${branch ? "branched" : "published"}'`;
      const after = `SELECT (SELECT rev FROM documents WHERE id = '${w.dStray}') || '|' ||
        (SELECT count(*) FROM revision_branches WHERE document_id = '${w.dStray}') || '|' ||
        (SELECT string_agg(details->>'branch', ',') FROM audit_logs WHERE resource_id = '${w.dStray}' AND action = 'REV_HOLD_OVERRIDDEN');`;
      const branch = both("docctrl", [pub(true)], after);
      expect(branch.before).toBe("ok:1 / A|1|true");
      expect(branch.after).toBe(branch.before);
      const plain = both("docctrl", [pub(false)], after);
      expect(plain.before).toBe("ok:1 / B|0|false");
      expect(plain.after).toBe(plain.before);
    });

    it("the version proof's boundary (P37 fix pass): a row naming a version of THIS document inserted in this transaction is admitted; one naming a version of ANOTHER document inserted in this transaction, or this document's version from an earlier committed transaction, is not", () => {
      const v = randomUUID();
      const named = (doc: string, ver: string) => `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
        VALUES ('REV_HOLD_OVERRIDDEN', '${doc}', 'document', '${w.org}', '${w.uid.docctrl}', jsonb_build_object('versionId', '${ver}', 'branch', true))`;
      const insV = (doc: string) => `INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, is_branch)
        VALUES ('${v}', '${w.org}', '${doc}', 'BR', 'p37/v.pdf', 'Minor', '${w.uid.docctrl}', true);`;
      expect(probeSeq(AFTER, w, "docctrl", [named(w.dStray, v)], count(w.dStray), insV(w.dStray)).out).toBe("ok:1 / 1");
      expect(probeSeq(AFTER, w, "docctrl", [named(w.dStray, v)], count(w.dStray), insV(w.dSheet)).out).toMatch(/^err:42501:.* \/ 0$/);
      expect(probeSeq(AFTER, w, "docctrl", [named(w.dStray, w.zA)], count(w.dStray)).out).toMatch(/^err:42501:.* \/ 0$/);
    });

    it("the service role (a restore, a server path) still writes one directly, on both sides; and a row naming no document of its workspace is refused to a member after", () => {
      const svc = both("service", [forged(w.dStray)], count(w.dStray));
      expect(svc.before).toBe("ok:1 / 1");
      expect(svc.after).toBe(svc.before);
      const notDoc = `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('REV_HOLD_OVERRIDDEN', 'not-a-document', 'project', '${w.org}', '${w.uid.docctrl}', '{}'::jsonb)`;
      const r = both("docctrl", [notDoc]);
      expect(r.before).toBe("ok:1");
      expect(r.after).toMatch(/^err:42501:/);
    });

    it("the rail's boundary, pinned: in ONE transaction that also wrote the document (two statements — no single PostgREST request is two statements), a member's row is admitted; a document written by ANOTHER, committed transaction is not this transaction's", () => {
      const same = probeSeq(AFTER, w, "docctrl", [`UPDATE documents SET title = 'touched' WHERE id = '${w.dStray}'`, forged(w.dStray)], count(w.dStray));
      expect(same.out).toBe("ok:1 / ok:1 / 1");
      // the seed's own committed writes are another transaction's
      expect(probeSeq(AFTER, w, "docctrl", [forged(w.dSheet)], count(w.dSheet)).out).toMatch(/^err:42501:/);
    });
  });
});

describe.skipIf(skip !== null)("20261254 pasted as ONE script, as the SQL editor sends it", () => {
  const SCRATCH = "mos_dc_p37_paste";
  const paste = (db: string) => runPsql(mosDb().conn!, db, "postgres", { sql: mig(FILE) });
  const rows = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });

  it("on a copy with 20261254 undone: every probe true, seven inventory rows (counts), a re-paste clean; the inventory counts a pending unproven door-shaped submission, and of those the checked-out ones; the operator's look-over row counts a reversal_restore record with no restore_reversed_source trace", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, UNDO_254);
      const results: Array<Record<string, number>> = [];
      for (let pass = 0; pass < 2; pass++) {
        const r = paste(SCRATCH);
        expect(r.errors, r.stderr).toEqual([]);
        const all = rows(r.stdout);
        const probes = all.filter((x) => x.ok !== "");
        const inventory = all.filter((x) => x.ok === "");
        expect(probes.length, `pass ${pass}`).toBe(11);
        expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
        expect(probes.every((p) => p.n === "")).toBe(true);
        expect(inventory.length).toBe(7);
        expect(inventory.every((x) => /^\d+$/.test(x.n)), JSON.stringify(inventory)).toBe(true);
        results.push(Object.fromEntries(inventory.map((x, i) => [String(i), Number(x.n)])));
      }
      // a re-paste counts the same world the same way (the paste moves no row)
      expect(results[1]).toEqual(results[0]);
      // a world with one unrecorded door-shaped submission on a checked-out document adds one to rows 1 and 2
      const w = ids();
      seed(SCRATCH, w);
      // REV-37's look-over (row 5): a hand-written reversal_restore record (no recorded split / merge names
      // its document), one naming the split but not of restore_reversed_source's shape, and a genuine-shaped one
      // on the split's own source (not counted)
      const rr = (doc: string, details: string) => `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
        VALUES ('REV_HOLD_OVERRIDDEN', '${doc}', 'document', '${w.org}', '${w.uid.docctrl}', ${details});`;
      const shape = `'priorStatus', 'Superseded', 'holds', jsonb_build_array(), 'branch', false, 'newStatus', 'Issued'`;
      admin(SCRATCH, [
        rr(w.dStray, `jsonb_build_object('via', 'reversal_restore', 'reversedAuditEventId', '${w.evSplit}', 'reversedAction', 'DOC_SPLIT', ${shape})`),
        rr(w.dSrc, `jsonb_build_object('via', 'reversal_restore', 'reversedAuditEventId', '${w.evSplit}', 'reversedAction', 'DOC_SPLIT', 'newStatus', 'Issued')`),
        rr(w.dSrc, `jsonb_build_object('via', 'reversal_restore', 'reversedAuditEventId', '${w.evSplit}', 'reversedAction', 'DOC_SPLIT', ${shape})`),
      ].join("\n"));
      const r = paste(SCRATCH);
      const inv = rows(r.stdout).filter((x) => x.ok === "").map((x) => Number(x.n));
      // the seed adds two unproven door-shaped submissions (x2A on a checked-out document, y2A on a free one; i2A
      // carries the route's record), two held documents named by unreversed operations (the sheet, the target)
      expect(inv[0]).toBe(results[1]["0"] + 2);
      expect(inv[1]).toBe(results[1]["1"] + 1);
      expect(inv[3]).toBe(results[1]["3"] + 3);
      expect(inv[4]).toBe(results[1]["4"] + 2);
      expect(inv[5]).toBe(results[1]["5"] + 2);
      expect(inv[6]).toBe(results[1]["6"]);
      // a server dead letter of the route's record proves x2A: row 1 counts one fewer
      admin(SCRATCH, `INSERT INTO audit_dead_letters (org_id, action, entry, error, source, reported_by) VALUES ('${w.org}', 'INTAKE_SUBMISSION',
        jsonb_build_object('row', jsonb_build_object('action', 'INTAKE_SUBMISSION', 'resource_id', '${w.dForged}', 'resource_type', 'document', 'org_id', '${w.org}', 'user_id', null,
          'details', jsonb_build_object('versionId', '${w.x2A}')), 'reporter', null), 'fetch failed', 'server', NULL);`);
      const inv2 = rows(paste(SCRATCH).stdout).filter((x) => x.ok === "").map((x) => Number(x.n));
      expect(inv2[0]).toBe(inv[0] - 1);
      expect(inv2[1]).toBe(inv[1] - 1);
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });

  it("the prerequisite refuses, changing nothing, on a database without 20261253's hold leg", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, UNDO_254);
      admin(SCRATCH, `${between(mig("20261245_dc_roundG_publish_guard_lock_leg.sql"), "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()", "\n$$;")}`);
      const state = () => admin(SCRATCH, "SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_audit_logs_hold_override_rail'");
      const a = paste(SCRATCH);
      expect(a.stderr).toContain("20261254 needs 20261253 (the hold leg in the publish guard) pasted first; nothing was changed.");
      expect(state()).toBe("0");
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });
});
