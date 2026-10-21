// document-control Round G — P35 DOOR B RECORD: 20261252 at RUNTIME on the
// replayed database (the I-17 harness; `npm run test:db`).
//
//   DCK-18  a reviewed promote over a checkout held by someone other than the
//           actor — the publish guard's door (b), ratified under DEC-90 — is
//           recorded (REVIEW_PROMOTED_OVER_CHECKOUT, via 'database') and the
//           holder told (a notice of the existing kind
//           revision_published_over_checkout) in the promote's OWN
//           transaction, whichever caller ran finalize_reviewed_promote; never
//           a refusal. Asked (p_report_over_checkout), the answer says what
//           was written, so the app neither doubles nor drops a row.
//
// Every statement runs on BOTH sides of the paste, in a transaction that is
// rolled back: "before" is a copy of the replay with 20261252 undone (the
// eight-argument function dropped, 20261151's seven-argument body and grants
// put back); "after" is the replay itself, which ran 20261252. REGRESSION
// FIRST: every promote lands (or is refused) exactly as before on both sides;
// only the record and the notice are new, and the reporting call is refused
// before the paste (42883 — the app's cue to call as it always did).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const AFTER = REPLAY_DB;
const BEFORE = "mos_dc_p35_before";
const FILE = "20261252_dc_roundG_door_b_record.sql";
const BASE = "20261151_dc_roundF_promote_transaction_and_hold_override.sql";
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const between = (s: string, a: string, b: string) => {
  const i = s.indexOf(a);
  return s.slice(i, s.indexOf(b, i + a.length) + b.length);
};
/** 20261252 undone: the eight-argument function dropped, 20261151's body and grants put back. */
const UNDO_252 = [
  "DROP FUNCTION IF EXISTS finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text, boolean);",
  between(mig(BASE), "CREATE OR REPLACE FUNCTION finalize_reviewed_promote(", "\n$$;"),
  "REVOKE ALL ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text) FROM PUBLIC, anon;",
  "GRANT EXECUTE ON FUNCTION finalize_reviewed_promote(uuid, uuid, uuid, text, uuid, boolean, text) TO authenticated, service_role;",
].join("\n");

const ROLES = { docctrl: "DocCtrl", holder: "Drafter", publisher: "Drafter", owner: "Viewer", reviewer: "Engineer-1" } as const;
type Member = keyof typeof ROLES;
type Who = Member | "service";

const ids = () => ({
  org: randomUUID(), lib: randomUUID(), project: randomUUID(), link: randomUUID(),
  // reviewed documents: Issued at A, pending 2A in review with a complete signed roster.
  // dReview checked out by the holder; dFree by nobody; dOwn by the publisher
  dReview: randomUUID(), rA: randomUUID(), r2A: randomUUID(),
  dFree: randomUUID(), fA: randomUUID(), f2A: randomUUID(),
  dOwn: randomUUID(), oA: randomUUID(), o2A: randomUUID(),
  // dIntake: born through the link, Issued at A, checked out by the holder; pending 2A is the door's submission
  dIntake: randomUUID(), iA: randomUUID(), i2A: randomUUID(),
  uid: Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomUUID()])) as Record<Member, string>,
});
type World = ReturnType<typeof ids>;

function seed(db: string, w: World): void {
  const u = w.uid;
  const tag = w.org.slice(0, 8);
  const reviewed = (doc: string, a: string, d2: string) => `
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, file_url, change_type, created_by, created_at, supersedes_version_id) VALUES
      ('${d2}', '${w.org}', '${doc}', '2A', 'B', 'in_review', 'p35/${tag}/${d2}.pdf', 'Major', '${u.holder}', now() - interval '1 day', '${a}');
    INSERT INTO e_signatures (id, org_id, resource_type, resource_id, document_version_id, intent, statement, signer_user_id, signer_name)
      VALUES ('${d2.slice(0, 8)}-0000-4000-8000-000000000001'::uuid, '${w.org}', 'document_version', '${d2}', '${d2}', 'Approved', 'I approve', '${u.reviewer}', 'reviewer');
    INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at)
      VALUES ('${d2.slice(0, 8)}-0000-4000-8000-000000000002'::uuid, '${w.org}', '${doc}', '${d2}', '${u.reviewer}', 'primary', true, 'signed', '${d2.slice(0, 8)}-0000-4000-8000-000000000001'::uuid, now());
    UPDATE documents SET pending_version_id = '${d2}' WHERE id = '${doc}';`;
  admin(db, `
    INSERT INTO orgs (id, name, type) VALUES ('${w.org}', 'P35 ${tag}', 'business');
    ${(Object.keys(ROLES) as Member[]).map((k) => `
    INSERT INTO auth.users (id, email, aud, role) VALUES ('${u[k]}', '${k}-${tag}@p35.test', 'authenticated', 'authenticated');
    INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${u[k]}', '${k}-${tag}@p35.test', '${k}', '${w.org}');
    INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${w.org}', '${u[k]}', '${k}-${tag}@p35.test', '${ROLES[k]}', ARRAY[]::text[], 'active');`).join("")}
    INSERT INTO libraries (id, org_id, name, type, acl_index) VALUES ('${w.lib}', '${w.org}', 'P35', 'documents',
      '{"allow":{"users":{"publish":["${u.holder}", "${u.publisher}"]}}}'::jsonb);
    INSERT INTO documents (id, org_id, library_id, title, document_number, status, owner_user_id) VALUES
      ('${w.dReview}', '${w.org}', '${w.lib}', 'Review', 'P35-R-${tag}', 'Draft', '${u.owner}'),
      ('${w.dFree}',   '${w.org}', '${w.lib}', 'Free',   'P35-F-${tag}', 'Draft', '${u.owner}'),
      ('${w.dOwn}',    '${w.org}', '${w.lib}', 'Own',    'P35-O-${tag}', 'Draft', '${u.owner}'),
      ('${w.dIntake}', '${w.org}', '${w.lib}', 'Intake', 'P35-I-${tag}', 'Draft', '${u.owner}');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, created_at) VALUES
      ('${w.rA}', '${w.org}', '${w.dReview}', 'A', 'p35/${tag}/ra.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.fA}', '${w.org}', '${w.dFree}',   'A', 'p35/${tag}/fa.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.oA}', '${w.org}', '${w.dOwn}',    'A', 'p35/${tag}/oa.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.iA}', '${w.org}', '${w.dIntake}', 'A', 'p35/${tag}/ia.pdf', 'Minor', '${u.holder}', now() - interval '2 days');
    UPDATE documents SET current_version_id = '${w.rA}', status = 'Issued', rev = 'A' WHERE id = '${w.dReview}';
    UPDATE documents SET current_version_id = '${w.fA}', status = 'Issued', rev = 'A' WHERE id = '${w.dFree}';
    UPDATE documents SET current_version_id = '${w.oA}', status = 'Issued', rev = 'A' WHERE id = '${w.dOwn}';
    UPDATE documents SET current_version_id = '${w.iA}', status = 'Issued', rev = 'A' WHERE id = '${w.dIntake}';
    -- history seeded with the triggers off (a roster row born signed is refused to a client — RG-1 — and an
    -- intake row is the door's)
    SET session_replication_role = replica;
    ${reviewed(w.dReview, w.rA, w.r2A)}
    ${reviewed(w.dFree, w.fA, w.f2A)}
    ${reviewed(w.dOwn, w.oA, w.o2A)}
    INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${w.project}', '${w.org}', 'P35 project', '${u.owner}', '${u.owner}');
    INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids)
      VALUES ('${w.link}', '${w.org}', '${w.project}', 'Contractor Co', md5('${w.link}') || md5('${w.org}'), now() + interval '30 days', '${u.owner}', ARRAY[]::uuid[]);
    UPDATE documents SET authored_by_link_id = '${w.link}' WHERE id = '${w.dIntake}';
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by, created_by_name, created_at, supersedes_version_id) VALUES
      ('${w.i2A}', '${w.org}', '${w.dIntake}', '2A', 'B', 'in_review', 'external', '${w.link}', 'p35/${tag}/i2a.pdf', 'Major', '${w.link}', 'Contractor Co', now() - interval '1 day', '${w.iA}');
    UPDATE documents SET pending_version_id = '${w.i2A}' WHERE id = '${w.dIntake}';
    RESET session_replication_role;
    UPDATE documents SET checked_out_by = '${u.holder}', checked_out_by_name = 'Holder Person', checked_out_at = now()
     WHERE id IN ('${w.dReview}', '${w.dIntake}');
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

/** The positional call PostgREST makes of the app's five named arguments (and a direct caller's). */
const call = (doc: string, pend: string, cur: string, actor = "NULL", answer = "promoted") =>
  `SELECT 1 WHERE finalize_reviewed_promote('${doc}', '${pend}', '${cur}', 'B', ${actor}) = '${answer}'`;
/** The app's call since P35: the same named arguments and the report flag. */
const reporting = (doc: string, pend: string, cur: string, answer: string, actor = "NULL") =>
  `SELECT 1 WHERE finalize_reviewed_promote(p_document_id => '${doc}', p_pending_id => '${pend}', p_expected_current => '${cur}', p_base_rev => 'B', p_actor => ${actor}, p_report_over_checkout => true) = '${answer}'`;
/** What the promote left: the pointer | the database's records | the holder's notices (and their shape). */
const left = (w: World, doc: string, holder = w.uid.holder) => `SELECT
  (SELECT COALESCE(current_version_id::text, 'none') FROM documents WHERE id = '${doc}') || '|' ||
  (SELECT count(*) FROM audit_logs WHERE resource_id = '${doc}' AND action = 'REVIEW_PROMOTED_OVER_CHECKOUT') || '|' ||
  (SELECT count(*) FROM notifications WHERE resource_id = '${doc}' AND kind = 'revision_published_over_checkout' AND user_id = '${holder}');`;
const recordOf = (doc: string) => `SELECT COALESCE(user_id::text, 'none') || '|' || COALESCE(user_email, 'none') || '|' || (details->>'via') || '|' || (details->>'holderUserId') || '|' ||
  (details->>'holderName') || '|' || (details->>'versionId') || '|' || (details->>'previousVersionId') || '|' || (details->>'revisionLabel') || '|' || (details->>'holderNotified')
  FROM audit_logs WHERE resource_id = '${doc}' AND action = 'REVIEW_PROMOTED_OVER_CHECKOUT';`;
const noticeOf = (doc: string) => `SELECT COALESCE(actor_user_id::text, 'none') || '|' || title || '|' || body || '|' || link || '|' || resource_type || '|' || (metadata->>'via') || '|' || (metadata->>'newRev')
  FROM notifications WHERE resource_id = '${doc}' AND kind = 'revision_published_over_checkout';`;

describe.skipIf(skip !== null)("DCK-18 (20261252): the reviewed promote over another person's checkout, recorded and told by the database", () => {
  let w: World;
  beforeAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${AFTER}`);
    admin(BEFORE, UNDO_252);
    w = ids();
    seed(BEFORE, w);
    seed(AFTER, w);
  });
  afterAll(() => { admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`); });

  const both = (who: Who, stmts: string[], after?: string, prelude = "") =>
    ({ before: probeSeq(BEFORE, w, who, stmts, after, prelude).out, after: probeSeq(AFTER, w, who, stmts, after, prelude).out });

  it("the two sides are what they say: the replay carries the eight-argument function, the copy 20261151's seven-argument one — one signature each", () => {
    const sig = (db: string) => admin(db, "SELECT string_agg(pronargs::text, ',') FROM pg_proc WHERE proname = 'finalize_reviewed_promote'");
    expect(sig(AFTER)).toBe("8");
    expect(sig(BEFORE)).toBe("7");
  });

  it("THE DEFECT, closed: a publisher's direct call of finalize_reviewed_promote (a PostgREST request, not the app) over the holder's checkout promotes on both sides — before, nobody is told and nothing records the pass; after, the holder's notice and the record land in the same transaction", () => {
    const r = both("publisher", [call(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
    expect(r.before).toBe(`ok:1 / ${w.r2A}|0|0`);
    expect(r.after).toBe(`ok:1 / ${w.r2A}|1|1`);
    const rec = probeSeq(AFTER, w, "publisher", [call(w.dReview, w.r2A, w.rA)], recordOf(w.dReview)).out;
    const tag = w.org.slice(0, 8);
    expect(rec).toBe(`ok:1 / ${w.uid.publisher}|publisher-${tag}@p35.test|database|${w.uid.holder}|Holder Person|${w.r2A}|${w.rA}|B|true`);
    const n = probeSeq(AFTER, w, "publisher", [call(w.dReview, w.r2A, w.rA)], noticeOf(w.dReview)).out;
    expect(n).toBe(`ok:1 / ${w.uid.publisher}|Reviewed Rev B published while you're checked out|publisher-${tag}@p35.test published the reviewed revision (reviewed as 2A). Your checkout stays open — check your work against Rev B before you publish.|/documents/${w.lib}?doc=${w.dReview}|document|database|B`);
  });

  it("the same for Document Control, and for the Intake tab's approve of a GENUINE external submission over the holder's checkout (no roster; the door's row)", () => {
    const d = both("docctrl", [call(w.dReview, w.r2A, w.rA)], left(w, w.dReview));
    expect(d.before).toBe(`ok:1 / ${w.r2A}|0|0`);
    expect(d.after).toBe(`ok:1 / ${w.r2A}|1|1`);
    const i = both("publisher", [call(w.dIntake, w.i2A, w.iA)], left(w, w.dIntake));
    expect(i.before).toBe(`ok:1 / ${w.i2A}|0|0`);
    expect(i.after).toBe(`ok:1 / ${w.i2A}|1|1`);
  });

  it("the app's reporting call (p_report_over_checkout): after the paste it answers what was written ('promoted_over_checkout_recorded_told'); before, PostgreSQL refuses it 42883 and nothing moves — the app's cue to call exactly as it always did", () => {
    const r = both("publisher", [reporting(w.dReview, w.r2A, w.rA, "promoted_over_checkout_recorded_told")], left(w, w.dReview));
    expect(r.before).toMatch(new RegExp(`^err:42883:.* / ${w.rA}\\|0\\|0$`));
    expect(r.after).toBe(`ok:1 / ${w.r2A}|1|1`);
  });

  it("REGRESSION: the holder's own promote and an unlocked document's are not a pass — promoted on both sides, no notice, no record; reported, the answer is 'promoted_clear'", () => {
    const own = both("publisher", [call(w.dOwn, w.o2A, w.oA)], left(w, w.dOwn, w.uid.publisher));
    expect(own.before).toBe(`ok:1 / ${w.o2A}|0|0`);
    expect(own.after).toBe(own.before);
    const free = both("publisher", [call(w.dFree, w.f2A, w.fA)], left(w, w.dFree));
    expect(free.before).toBe(`ok:1 / ${w.f2A}|0|0`);
    expect(free.after).toBe(free.before);
    expect(probeSeq(AFTER, w, "publisher", [reporting(w.dOwn, w.o2A, w.oA, "promoted_clear")], left(w, w.dOwn, w.uid.publisher)).out).toBe(`ok:1 / ${w.o2A}|0|0`);
    expect(probeSeq(AFTER, w, "publisher", [reporting(w.dFree, w.f2A, w.fA, "promoted_clear")], left(w, w.dFree)).out).toBe(`ok:1 / ${w.f2A}|0|0`);
  });

  it("REGRESSION: a promote that does not land records nothing — a compare-and-set that matches no row answers 'no_match' on both sides; a refusal by the guard (an active hold, no force) rolls everything back on both sides", () => {
    const nm = both("publisher", [call(w.dReview, w.r2A, w.fA, "NULL", "no_match")], left(w, w.dReview));
    expect(nm.before).toBe(`ok:1 / ${w.rA}|0|0`);
    expect(nm.after).toBe(nm.before);
    const hold = `INSERT INTO document_holds (org_id, document_id, reason, opened_by) VALUES ('${w.org}', '${w.dReview}', 'Other', '${w.uid.docctrl}');`;
    const h = both("publisher", [call(w.dReview, w.r2A, w.rA)], left(w, w.dReview), hold);
    expect(h.before).toMatch(new RegExp(`^err:[0-9A-Z]{5}:.* / ${w.rA}\\|0\\|0$`));
    expect(h.after).toBe(h.before);
  });

  it("the service role (a server path naming p_actor): recorded as that actor; its own holder's promote is no pass; with no actor at all the record names no person", () => {
    const named = both("service", [call(w.dReview, w.r2A, w.rA, `'${w.uid.publisher}'`)], left(w, w.dReview));
    expect(named.before).toBe(`ok:1 / ${w.r2A}|0|0`);
    expect(named.after).toBe(`ok:1 / ${w.r2A}|1|1`);
    expect(probeSeq(AFTER, w, "service", [call(w.dReview, w.r2A, w.rA, `'${w.uid.publisher}'`)], recordOf(w.dReview)).out)
      .toMatch(new RegExp(`^ok:1 / ${w.uid.publisher}\\|publisher-.*\\|database\\|${w.uid.holder}\\|`));
    const self = both("service", [call(w.dReview, w.r2A, w.rA, `'${w.uid.holder}'`)], left(w, w.dReview));
    expect(self.after).toBe(`ok:1 / ${w.r2A}|0|0`);
    expect(self.after).toBe(self.before);
    expect(probeSeq(AFTER, w, "service", [call(w.dReview, w.r2A, w.rA)], recordOf(w.dReview)).out)
      .toMatch(new RegExp(`^ok:1 / none\\|none\\|database\\|${w.uid.holder}\\|`));
  });

  it("FAIL-SAFE: a notice or a record that cannot be written never refuses the promote — the publish stands, a WARNING is raised, and the report says which write is missing (so the app writes it)", () => {
    const FN = "CREATE OR REPLACE FUNCTION public.p35_refuse() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RAISE EXCEPTION 'p35 refused'; END $f$;";
    const on = (table: string) => `CREATE TRIGGER p35_refuse_${table} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.p35_refuse();`;
    const refuse = (...tables: string[]) => [FN, ...tables.map(on)].join("\n");
    const noNotice = probeSeq(AFTER, w, "publisher", [reporting(w.dReview, w.r2A, w.rA, "promoted_over_checkout_recorded")], left(w, w.dReview), refuse("notifications"));
    expect(noNotice.out).toBe(`ok:1 / ${w.r2A}|1|0`);
    expect(noNotice.stderr).toContain("their notice was not written (the publish stands): p35 refused");
    const noRecord = probeSeq(AFTER, w, "publisher", [reporting(w.dReview, w.r2A, w.rA, "promoted_over_checkout_told")], left(w, w.dReview), refuse("audit_logs"));
    expect(noRecord.out).toBe(`ok:1 / ${w.r2A}|0|1`);
    expect(noRecord.stderr).toContain("the record was not written (the publish stands): p35 refused");
    const neither = probeSeq(AFTER, w, "publisher", [reporting(w.dReview, w.r2A, w.rA, "promoted_over_checkout")], left(w, w.dReview), refuse("notifications", "audit_logs"));
    expect(neither.out).toBe(`ok:1 / ${w.r2A}|0|0`);
    // the direct caller's plain answer is unchanged too
    expect(probeSeq(AFTER, w, "publisher", [call(w.dReview, w.r2A, w.rA)], left(w, w.dReview), refuse("notifications")).out).toBe(`ok:1 / ${w.r2A}|1|0`);
  });

  it("a holder who is no longer an active member is not sent a notice (the insert rail skips the row — 20261160 rule 5); the pass is still recorded and the report says the holder was not told", () => {
    const gone = `UPDATE org_members SET status = 'suspended' WHERE org_id = '${w.org}' AND uid = '${w.uid.holder}';`;
    const r = probeSeq(AFTER, w, "publisher", [reporting(w.dReview, w.r2A, w.rA, "promoted_over_checkout_recorded")], left(w, w.dReview), gone);
    expect(r.out).toBe(`ok:1 / ${w.r2A}|1|0`);
  });

  it("the remainder, pinned (DEC-90 ruling (3) for P35): the three-step PATCH sent by hand over the holder's checkout — door (b) for the guard — lands on both sides and is NOT recorded by this file (recorded on DCK-18 with its owner)", () => {
    const threeStep = [
      `UPDATE documents SET current_version_id = '${w.r2A}', rev = 'B', revision = 'B', status = 'Issued', pending_version_id = NULL
        WHERE id = '${w.dReview}' AND pending_version_id = '${w.r2A}' AND current_version_id = '${w.rA}'`,
    ];
    const r = both("publisher", threeStep, left(w, w.dReview));
    expect(r.before).toBe(`ok:1 / ${w.r2A}|0|0`);
    expect(r.after).toBe(r.before);
  });
});

describe.skipIf(skip !== null)("20261252 pasted as ONE script, as the SQL editor sends it", () => {
  const SCRATCH = "mos_dc_p35_paste";
  const paste = (db: string) => runPsql(mosDb().conn!, db, "postgres", { sql: mig(FILE) });
  const rows = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });

  it("on a copy with 20261252 undone: every probe true, the six inventory rows are counts, a re-paste is clean — and the done-when-3 rows split the pending door-shaped submissions by the intake route's own record and by whether a project's Intake tab (DOCUMENT links only) lists them; the header's three read-only queries count and list the same rows", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    const o = { org: randomUUID(), lib: randomUUID(), link: randomUUID(), project: randomUUID(),
      dGenuine: randomUUID(), gA: randomUUID(), g2A: randomUUID(), dForged: randomUUID(), xA: randomUUID(), x2A: randomUUID(),
      qlink: randomUUID(), dQuote: randomUUID(), qA: randomUUID(), q2A: randomUUID() };
    const tag = o.org.slice(0, 8);
    const world = `ALTER TABLE document_versions ALTER COLUMN created_by DROP NOT NULL;
      SET session_replication_role = replica;
      INSERT INTO orgs (id, name, type) VALUES ('${o.org}', 'P35 inventory', 'business');
      INSERT INTO libraries (id, org_id, name, type) VALUES ('${o.lib}', '${o.org}', 'P35 inventory', 'documents');
      INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${o.project}', '${o.org}', 'P35 inventory project', gen_random_uuid(), gen_random_uuid());
      INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids)
        VALUES ('${o.link}', '${o.org}', '${o.project}', 'Inv Co', md5('${o.link}') || md5('${o.org}'), now() + interval '30 days', gen_random_uuid(), ARRAY[]::uuid[]);
      -- a QUOTE link (20261013): the Intake tab never lists it, so a door-shaped row naming it is not one the tab retires
      INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids, purpose)
        VALUES ('${o.qlink}', '${o.org}', '${o.project}', 'Quote Co', md5('${o.qlink}') || md5('${o.org}'), now() + interval '30 days', gen_random_uuid(), ARRAY[]::uuid[], 'quote');
      INSERT INTO documents (id, org_id, library_id, title, document_number, status) VALUES
        ('${o.dGenuine}', '${o.org}', '${o.lib}', 'Genuine', 'P35-G-${tag}', 'Issued'),
        ('${o.dForged}',  '${o.org}', '${o.lib}', 'Forged',  'P35-X-${tag}', 'Issued'),
        ('${o.dQuote}',   '${o.org}', '${o.lib}', 'OnQuote', 'P35-Q-${tag}', 'Issued');
      INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, review_state, provenance, intake_link_id) VALUES
        ('${o.gA}',  '${o.org}', '${o.dGenuine}', 'A',  'p35inv/ga.pdf',  'Minor', NULL, NULL, NULL, NULL),
        ('${o.g2A}', '${o.org}', '${o.dGenuine}', '2A', 'p35inv/g2a.pdf', 'Major', NULL, 'in_review', 'external', '${o.link}'),
        ('${o.xA}',  '${o.org}', '${o.dForged}',  'A',  'p35inv/xa.pdf',  'Minor', NULL, NULL, NULL, NULL),
        ('${o.x2A}', '${o.org}', '${o.dForged}',  '2A', 'p35inv/x2a.pdf', 'Major', '${o.link}', 'in_review', 'external', '${o.link}'),
        ('${o.qA}',  '${o.org}', '${o.dQuote}',   'A',  'p35inv/qa.pdf',  'Minor', NULL, NULL, NULL, NULL),
        ('${o.q2A}', '${o.org}', '${o.dQuote}',   '2A', 'p35inv/q2a.pdf', 'Major', '${o.qlink}', 'in_review', 'external', '${o.qlink}');
      UPDATE documents SET current_version_id = '${o.gA}', pending_version_id = '${o.g2A}' WHERE id = '${o.dGenuine}';
      UPDATE documents SET current_version_id = '${o.xA}', pending_version_id = '${o.x2A}', checked_out_by = gen_random_uuid() WHERE id = '${o.dForged}';
      UPDATE documents SET current_version_id = '${o.qA}', pending_version_id = '${o.q2A}' WHERE id = '${o.dQuote}';
      -- the route's own record of the genuine one (server-written, no person named)
      INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
        VALUES ('INTAKE_SUBMISSION', '${o.dGenuine}', 'document', '${o.org}', NULL, jsonb_build_object('versionId', '${o.g2A}', 'company', 'Inv Co'));
      RESET session_replication_role;`;
    const LABELS = { checkedOut: "documents checked out right now whose pending draft is in review", sigs: "finalize_reviewed_promote signatures", pending: "row 2, recounted", recorded: "named by the intake route", look: "listed on a project's Intake tab — look these over", offTab: "NOT listed on any project's Intake tab" } as const;
    type Counts = Record<keyof typeof LABELS, number>;
    // the header's own queries, cut from the file and uncommented (read-only: they never write)
    const header = mig(FILE).slice(0, mig(FILE).indexOf("-- PASTE ORDER:"));
    const query = (from: string, to: string) => header.slice(header.indexOf(from), header.indexOf(to, header.indexOf(from)) + to.length)
      .split("\n").map((l) => l.replace(/^--\s{0,6}/, "")).join("\n");
    const countQuery = query("WITH s AS (", "FROM s;");
    const listQuery = query("SELECT p.name AS project", "ORDER BY v.created_at;");
    const offTabQuery = query("SELECT l.purpose AS link_purpose", "ORDER BY v.created_at;");
    try {
      admin(SCRATCH, UNDO_252);
      const counts: Counts[] = [];
      for (let pass = 0; pass < 3; pass++) {
        if (pass === 1) admin(SCRATCH, world);
        const r = paste(SCRATCH);
        expect(r.errors, r.stderr).toEqual([]);
        const all = rows(r.stdout);
        const probes = all.filter((x) => x.ok !== "");
        const inventory = all.filter((x) => x.ok === "");
        expect(probes.length, `pass ${pass}`).toBe(6);
        expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
        expect(probes.every((p) => p.n === "")).toBe(true);
        expect(inventory.length).toBe(6);
        expect(inventory.every((x) => /^\d+$/.test(x.n)), JSON.stringify(inventory)).toBe(true);
        const c = {} as Counts;
        for (const [k, label] of Object.entries(LABELS) as Array<[keyof typeof LABELS, string]>) {
          const hit = inventory.filter((x) => x.check.includes(label));
          expect(hit.length, label).toBe(1);
          c[k] = Number(hit[0].n);
        }
        counts.push(c);
      }
      // first paste: the seven-argument base; the re-pastes: this file's own eight-argument form
      expect(counts[0].sigs).toBe(1);
      expect(counts[1].sigs).toBe(1);
      // the world adds three pending door-shaped submissions: the route recorded one; the forged look on the
      // document link, also checked out (a pending draft in review), is the one to look over; the one on the
      // quote link is on no Intake tab, so it is counted apart (row 6), never as one the tab retires
      expect(counts[1]).toEqual({ ...counts[0], checkedOut: counts[0].checkedOut + 1, pending: counts[0].pending + 3, recorded: counts[0].recorded + 1, look: counts[0].look + 1, offTab: counts[0].offTab + 1 });
      expect(counts[2]).toEqual(counts[1]);
      // the header's queries: the same split, and the list names only the forged one
      const totals = admin(SCRATCH, countQuery);
      expect(totals).toBe(`${counts[1].pending}|${counts[1].recorded}|${counts[1].look}|${counts[1].offTab}`);
      const mine = (out: string) => out.split("\n").filter((l) => l.includes(o.dForged) || l.includes(o.dGenuine) || l.includes(o.dQuote));
      const list = mine(admin(SCRATCH, listQuery));
      expect(list).toHaveLength(1);
      expect(list[0]).toContain(`P35 inventory project|Inv Co|P35-X-${tag}|Forged|2A|`);
      expect(list[0]).toContain(`|${o.dForged}|${o.x2A}`);
      const offTab = mine(admin(SCRATCH, offTabQuery));
      expect(offTab).toHaveLength(1);
      expect(offTab[0]).toContain(`quote|P35 inventory project|Quote Co|P35-Q-${tag}|OnQuote|2A|`);
      expect(offTab[0]).toContain(`|${o.dQuote}|${o.q2A}`);
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });

  it("the prerequisite refuses, changing nothing, on a database without 20261247's column guard", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, UNDO_252);
      admin(SCRATCH, "DROP TRIGGER IF EXISTS trg_document_version_row_integrity ON document_versions; DROP FUNCTION IF EXISTS enforce_document_version_row_integrity();");
      const state = () => admin(SCRATCH, "SELECT string_agg(pronargs::text, ',') FROM pg_proc WHERE proname = 'finalize_reviewed_promote'");
      const was = state();
      const a = paste(SCRATCH);
      expect(a.stderr).toContain("20261252 needs 20261247 (the version row column guard) pasted first; nothing was changed.");
      expect(state()).toBe(was);
      expect(was).toBe("7");
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });
});
