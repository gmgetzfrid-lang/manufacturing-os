// document-control Round G — P32 PUBLISH GUARD LOCK LEG: 20261245 at RUNTIME
// on the replayed database (the I-17 harness; `npm run test:db`).
//
//   HAND-13 (drafting-flow) done-when 2: enforce_document_publish_guard gains
//           a lock leg — a write that makes a NEW revision current on a
//           document checked out by someone else is refused (42501), Document
//           Control included, unless it is publish_revision's own promote
//           (whose lock rules — the holder, a recorded publisher override
//           with its reason, a controller's recorded force — already ran) or
//           the reviewed promote of the pending draft (finalize_reviewed_
//           promote and its three-step fallback, which never read the lock)
//           whose content a review decided: a bound roster the review gate
//           proved complete, or an external submission as the intake door
//           writes it (no creator, 'external', a link of this org whose scope
//           holds the document). A draft a publisher forges — labelled in
//           review and external, with a creator or a link that does not scope
//           the document — borrows nothing (the P32 review's reproduction).
//
// Every statement runs on BOTH sides of the paste, in a transaction that is
// rolled back: "before" is a copy of the replay with 20261193's guard (the
// newest body this file re-creates) put back; "after" is the replay itself,
// which ran 20261245. What works today for a legitimate user answers the
// same on both sides (REGRESSION FIRST); only a pointer write over another
// person's checkout outside the two doors changes, from admitted to 42501.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const AFTER = REPLAY_DB;
const BEFORE = "mos_dc_p32_before";
const FILE = "20261245_dc_roundG_publish_guard_lock_leg.sql";
const BASE = "20261193_dc_roundF_ifc_rev_up_first_issue.sql";
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const guardOf = (f: string) => {
  const s = mig(f);
  const a = s.indexOf(GUARD_HEAD);
  return s.slice(a, s.indexOf("\n$$;", a) + "\n$$;".length);
};

const ROLES = {
  admin: "Admin", docctrl: "DocCtrl", holder: "Drafter", publisher: "Drafter", owner: "Viewer",
  engineer: "Engineer-2", reviewer: "Engineer-1",
} as const;
type Member = keyof typeof ROLES;
type Who = Member | "service";

const ids = () => ({
  org: randomUUID(), lib: randomUUID(),
  // dLocked: Issued at A, checked out by the holder, a B revision on file (made earlier)
  dLocked: randomUUID(), vA: randomUUID(), vB: randomUUID(),
  // dFree: Issued at A, nobody holds it
  dFree: randomUUID(), fA: randomUUID(), fB: randomUUID(),
  // dFirst: no current revision yet, checked out by the holder, one revision on file
  dFirst: randomUUID(), firstA: randomUUID(),
  // dReview: Issued at A, checked out by the holder, a pending draft 2A in review with a complete roster
  dReview: randomUUID(), rA: randomUUID(), r2A: randomUUID(), sig: randomUUID(), so: randomUUID(),
  // dStale: Issued at A, checked out by the holder, a pending draft NOT marked in review
  dStale: randomUUID(), sA: randomUUID(), s2A: randomUUID(),
  // dHeld: Issued at A, checked out by the holder, an active hold
  dHeld: randomUUID(), hA: randomUUID(), hold: randomUUID(),
  // the intake world: a project and one of its document links
  project: randomUUID(), link: randomUUID(),
  // dForge: Issued at A, checked out by the holder, an ordinary document; the publisher's
  // forged "external submission" 2A (a creator, an intake link id that names no link) on file, a day old
  dForge: randomUUID(), gA: randomUUID(), g2A: randomUUID(), fakeLink: randomUUID(),
  // dOut: Issued at A, checked out by the holder; pending 2A has no creator and names the REAL link,
  // but the document is outside that link's scope (not authored by it, not assigned to it)
  dOut: randomUUID(), oA: randomUUID(), o2A: randomUUID(),
  // dIntake: born through the link (authored_by_link_id), Issued at A, checked out by the holder;
  // pending 2A is the door's own submission (no creator, 'external', the link)
  dIntake: randomUUID(), iA: randomUUID(), i2A: randomUUID(),
  // dAssigned: an org document ASSIGNED to the link, same shape
  dAssigned: randomUUID(), asA: randomUUID(), as2A: randomUUID(),
  uid: Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomUUID()])) as Record<Member, string>,
});
type World = ReturnType<typeof ids>;

function seed(db: string, w: World): void {
  const u = w.uid;
  const tag = w.org.slice(0, 8);
  admin(db, `
    INSERT INTO orgs (id, name, type) VALUES ('${w.org}', 'P32 ${tag}', 'business');
    ${(Object.keys(ROLES) as Member[]).map((k) => `
    INSERT INTO auth.users (id, email, aud, role) VALUES ('${u[k]}', '${k}-${tag}@p32.test', 'authenticated', 'authenticated');
    INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${u[k]}', '${k}-${tag}@p32.test', '${k}', '${w.org}');
    INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${w.org}', '${u[k]}', '${k}-${tag}@p32.test', '${ROLES[k]}', ARRAY[]::text[], 'active');`).join("")}
    INSERT INTO libraries (id, org_id, name, type, acl_index) VALUES ('${w.lib}', '${w.org}', 'P32', 'documents',
      '{"allow":{"users":{"publish":["${u.holder}", "${u.publisher}"]}}}'::jsonb);
    INSERT INTO documents (id, org_id, library_id, title, document_number, status, owner_user_id) VALUES
      ('${w.dLocked}', '${w.org}', '${w.lib}', 'Locked', 'P32-L-${tag}', 'Draft', '${u.owner}'),
      ('${w.dFree}',   '${w.org}', '${w.lib}', 'Free',   'P32-F-${tag}', 'Draft', '${u.owner}'),
      ('${w.dFirst}',  '${w.org}', '${w.lib}', 'First',  'P32-1-${tag}', 'Draft', '${u.owner}'),
      ('${w.dReview}', '${w.org}', '${w.lib}', 'Review', 'P32-R-${tag}', 'Draft', '${u.owner}'),
      ('${w.dStale}',  '${w.org}', '${w.lib}', 'Stale',  'P32-S-${tag}', 'Draft', '${u.owner}'),
      ('${w.dHeld}',   '${w.org}', '${w.lib}', 'Held',   'P32-H-${tag}', 'Draft', '${u.owner}'),
      ('${w.dForge}',  '${w.org}', '${w.lib}', 'Forge',  'P32-G-${tag}', 'Draft', '${u.owner}'),
      ('${w.dOut}',    '${w.org}', '${w.lib}', 'Out',    'P32-O-${tag}', 'Draft', '${u.owner}'),
      ('${w.dIntake}', '${w.org}', '${w.lib}', 'Intake', 'P32-I-${tag}', 'Draft', '${u.owner}'),
      ('${w.dAssigned}', '${w.org}', '${w.lib}', 'Assigned', 'P32-A-${tag}', 'Draft', '${u.owner}');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, created_at) VALUES
      ('${w.vA}', '${w.org}', '${w.dLocked}', 'A', 'p32/${tag}/la.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.vB}', '${w.org}', '${w.dLocked}', 'B', 'p32/${tag}/lb.pdf', 'Minor', '${u.publisher}', now() - interval '1 day'),
      ('${w.fA}', '${w.org}', '${w.dFree}', 'A', 'p32/${tag}/fa.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.fB}', '${w.org}', '${w.dFree}', 'B', 'p32/${tag}/fb.pdf', 'Minor', '${u.publisher}', now() - interval '1 day'),
      ('${w.firstA}', '${w.org}', '${w.dFirst}', 'A', 'p32/${tag}/1a.pdf', 'Minor', '${u.publisher}', now() - interval '1 day'),
      ('${w.rA}', '${w.org}', '${w.dReview}', 'A', 'p32/${tag}/ra.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.sA}', '${w.org}', '${w.dStale}', 'A', 'p32/${tag}/sa.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.hA}', '${w.org}', '${w.dHeld}', 'A', 'p32/${tag}/ha.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.gA}', '${w.org}', '${w.dForge}', 'A', 'p32/${tag}/ga.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.oA}', '${w.org}', '${w.dOut}', 'A', 'p32/${tag}/oa.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.iA}', '${w.org}', '${w.dIntake}', 'A', 'p32/${tag}/ia.pdf', 'Minor', '${u.holder}', now() - interval '2 days'),
      ('${w.asA}', '${w.org}', '${w.dAssigned}', 'A', 'p32/${tag}/asa.pdf', 'Minor', '${u.holder}', now() - interval '2 days');
    UPDATE documents SET current_version_id = '${w.vA}', status = 'Issued', rev = 'A' WHERE id = '${w.dLocked}';
    UPDATE documents SET current_version_id = '${w.fA}', status = 'Issued', rev = 'A' WHERE id = '${w.dFree}';
    UPDATE documents SET current_version_id = '${w.rA}', status = 'Issued', rev = 'A' WHERE id = '${w.dReview}';
    UPDATE documents SET current_version_id = '${w.sA}', status = 'Issued', rev = 'A' WHERE id = '${w.dStale}';
    UPDATE documents SET current_version_id = '${w.hA}', status = 'Issued', rev = 'A' WHERE id = '${w.dHeld}';
    UPDATE documents SET current_version_id = '${w.gA}', status = 'Issued', rev = 'A' WHERE id = '${w.dForge}';
    UPDATE documents SET current_version_id = '${w.oA}', status = 'Issued', rev = 'A' WHERE id = '${w.dOut}';
    UPDATE documents SET current_version_id = '${w.iA}', status = 'Issued', rev = 'A' WHERE id = '${w.dIntake}';
    UPDATE documents SET current_version_id = '${w.asA}', status = 'Issued', rev = 'A' WHERE id = '${w.dAssigned}';
    -- the pending drafts and the reviewer's bound signature (seeded with the triggers off: a
    -- roster row born signed is refused to a client — RG-1 — and is history here, not under test)
    SET session_replication_role = replica;
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, file_url, change_type, created_by, created_at, supersedes_version_id) VALUES
      ('${w.r2A}', '${w.org}', '${w.dReview}', '2A', 'B', 'in_review', 'p32/${tag}/r2a.pdf', 'Major', '${u.holder}', now() - interval '1 day', '${w.rA}'),
      ('${w.s2A}', '${w.org}', '${w.dStale}', '2A', 'B', NULL, 'p32/${tag}/s2a.pdf', 'Minor', '${u.holder}', now() - interval '1 day', '${w.sA}');
    INSERT INTO e_signatures (id, org_id, resource_type, resource_id, document_version_id, intent, statement, signer_user_id, signer_name)
      VALUES ('${w.sig}', '${w.org}', 'document_version', '${w.r2A}', '${w.r2A}', 'Approved', 'I approve', '${u.reviewer}', 'reviewer');
    INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at)
      VALUES ('${w.so}', '${w.org}', '${w.dReview}', '${w.r2A}', '${u.reviewer}', 'primary', true, 'signed', '${w.sig}', now());
    UPDATE documents SET pending_version_id = '${w.r2A}' WHERE id = '${w.dReview}';
    UPDATE documents SET pending_version_id = '${w.s2A}' WHERE id = '${w.dStale}';
    -- the intake world (as the door and the route leave it: the link, the document it authored, an
    -- assignment, its submissions with no member as creator — 20261184 / 20261214 leave the column
    -- out; schema.sql's NOT NULL, which this replay keeps and the live table does not enforce (SEC-22),
    -- is met with the link's own id, what a live default auth.uid() yields under the door's bound
    -- identity; the NULL shape is exercised with the constraint dropped inside the probe)
    INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${w.project}', '${w.org}', 'P32 project', '${u.owner}', '${u.owner}');
    INSERT INTO project_intake_links (id, org_id, project_id, company_name, token_hash, expires_at, created_by, assigned_doc_ids)
      VALUES ('${w.link}', '${w.org}', '${w.project}', 'Contractor Co', md5('${w.link}') || md5('${w.org}'), now() + interval '30 days', '${u.owner}', ARRAY['${w.dAssigned}']::uuid[]);
    UPDATE documents SET authored_by_link_id = '${w.link}' WHERE id = '${w.dIntake}';
    INSERT INTO document_versions (id, org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by, created_by_name, created_at, supersedes_version_id) VALUES
      ('${w.g2A}', '${w.org}', '${w.dForge}', '2A', 'B', 'in_review', 'external', '${w.fakeLink}', 'p32/${tag}/g2a.pdf', 'Major', '${u.publisher}', 'publisher', now() - interval '1 day', '${w.gA}'),
      ('${w.o2A}', '${w.org}', '${w.dOut}', '2A', 'B', 'in_review', 'external', '${w.link}', 'p32/${tag}/o2a.pdf', 'Major', '${w.link}', 'Contractor Co', now() - interval '1 day', '${w.oA}'),
      ('${w.i2A}', '${w.org}', '${w.dIntake}', '2A', 'B', 'in_review', 'external', '${w.link}', 'p32/${tag}/i2a.pdf', 'Major', '${w.link}', 'Contractor Co', now() - interval '1 day', '${w.iA}'),
      ('${w.as2A}', '${w.org}', '${w.dAssigned}', '2A', 'B', 'in_review', 'external', '${w.link}', 'p32/${tag}/as2a.pdf', 'Major', '${w.link}', 'Contractor Co', now() - interval '1 day', '${w.asA}');
    UPDATE documents SET pending_version_id = '${w.o2A}' WHERE id = '${w.dOut}';
    UPDATE documents SET pending_version_id = '${w.i2A}' WHERE id = '${w.dIntake}';
    UPDATE documents SET pending_version_id = '${w.as2A}' WHERE id = '${w.dAssigned}';
    RESET session_replication_role;
    INSERT INTO document_holds (id, org_id, document_id, reason, notes, opened_by) VALUES ('${w.hold}', '${w.org}', '${w.dHeld}', 'Other', 'p32 harness', '${u.docctrl}');
    UPDATE documents SET checked_out_by = '${u.holder}', checked_out_by_name = 'Holder Person', checked_out_at = now()
     WHERE id IN ('${w.dLocked}', '${w.dFirst}', '${w.dReview}', '${w.dStale}', '${w.dHeld}', '${w.dForge}', '${w.dOut}', '${w.dIntake}', '${w.dAssigned}');`);
}

/** One statement as `who`, as PostgREST runs it, in a transaction that is rolled back.
 *  `after` runs as the superuser before the rollback (reads what the statement wrote). */
function probe(db: string, w: World, who: Who, stmt: string, after?: string): string {
  const { conn } = mosDb();
  const claims = who === "service" ? { role: "service_role" } : { role: "authenticated", sub: w.uid[who] };
  const role = who === "service" ? "service_role" : "authenticated";
  const sql = [
    "BEGIN;",
    `SET LOCAL ROLE ${role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(JSON.stringify(claims))}, true);`,
    `SELECT harness.try_sql(${dollarQuote(stmt)});`,
    ...(after ? ["RESET ROLE;", after] : []),
    "ROLLBACK;",
  ].join("\n");
  const r = runPsql(conn!, db, conn!.superuser, { sql });
  if (!r.ok) throw new Error(`probe failed on ${db} as ${who}: ${r.error ?? r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0).slice(1).join(" / ");
}

/** Several statements as `who`, each its own savepointed call, in ONE transaction that is rolled
 *  back (a sequence of PostgREST requests; none of the rows they read was made in it). `prelude`
 *  runs first as the superuser, inside the same rolled-back transaction (its output lines are
 *  silent DDL/DML tags, which psql -t does not print for these statements). */
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

const pointer = (w: World, doc: string) => `SELECT COALESCE(current_version_id::text, 'none') FROM documents WHERE id = '${doc}';`;
const patch = (doc: string, ver: string, label = "B") => `UPDATE documents SET current_version_id = '${ver}', rev = '${label}', revision = '${label}' WHERE id = '${doc}'`;
/** publish_revision as the caller, answering ok:1 only when it published (its status otherwise). */
const publish = (doc: string, base: string, extra = "") =>
  `SELECT 1 FROM (SELECT publish_revision(p_doc := '${doc}', p_expected_base := '${base}', p_op_class := 'content',
     p_version := '{"revision_label":"C","file_url":"p32/c.pdf","change_type":"Minor","change_log":"p32"}'::jsonb,
     p_actor := NULL${extra}) AS r) x WHERE x.r->>'status' = 'published'`;
const publishStatus = (doc: string, base: string, extra = "") =>
  `SELECT publish_revision(p_doc := '${doc}', p_expected_base := '${base}', p_op_class := 'content',
     p_version := '{"revision_label":"C","file_url":"p32/c.pdf","change_type":"Minor","change_log":"p32"}'::jsonb,
     p_actor := NULL${extra})->>'status'`;

describe.skipIf(skip !== null)("HAND-13 (20261245): the checkout lock at the database, before and after the paste", () => {
  let w: World;

  beforeAll(() => {
    // "before": the replay with 20261193's guard put back (the body this file re-creates)
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${AFTER}`);
    admin(BEFORE, `${guardOf(BASE)}\nREVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;`);
    w = ids();
    seed(BEFORE, w);
    seed(AFTER, w);
  });
  afterAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
  });

  it("the two sides are what they say: the replay carries the lock leg, the copy carries 20261193's body without it", () => {
    const has = (db: string) => admin(db, `SELECT prosrc LIKE '%IF OLD.checked_out_by IS NOT NULL%insufficient_privilege%' FROM pg_proc WHERE proname = 'enforce_document_publish_guard'`);
    expect(has(AFTER)).toBe("t");
    expect(has(BEFORE)).toBe("f");
  });

  const both = (who: Who, stmt: string, after?: string) => ({ before: probe(BEFORE, w, who, stmt, after), after: probe(AFTER, w, who, stmt, after) });

  it("THE DEFECT, closed: a direct pointer write over another person's checkout — by a library publisher, the document's owner, Document Control or an Admin — was admitted before and is refused 42501 after, naming the holder; nothing moves", () => {
    for (const who of ["publisher", "owner", "docctrl", "admin"] as const) {
      const r = both(who, patch(w.dLocked, w.vB), pointer(w, w.dLocked));
      expect(r.before, `${who} before`).toBe(`ok:1 / ${w.vB}`);
      expect(r.after, `${who} after`).toMatch(new RegExp(`^err:42501:This document is checked out by Holder Person, so a new revision can't be made current here; .* / ${w.vA}$`));
    }
  });

  it("a FIRST pointer write on a document someone else holds is refused after (admitted before); the holder's first pointer write lands on both sides", () => {
    const r = both("publisher", patch(w.dFirst, w.firstA, "A"), pointer(w, w.dFirst));
    expect(r.before).toBe(`ok:1 / ${w.firstA}`);
    expect(r.after).toMatch(new RegExp(`^err:42501:.* / none$`));
    const h = both("holder", patch(w.dFirst, w.firstA, "A"), pointer(w, w.dFirst));
    expect(h.before).toBe(`ok:1 / ${w.firstA}`);
    expect(h.after).toBe(`ok:1 / ${w.firstA}`);
  });

  it("REGRESSION: the lock HOLDER's direct pointer write lands on both sides", () => {
    const r = both("holder", patch(w.dLocked, w.vB), pointer(w, w.dLocked));
    expect(r.before).toBe(`ok:1 / ${w.vB}`);
    expect(r.after).toBe(r.before);
  });

  it("REGRESSION: a pointer write on an UNLOCKED document lands on both sides (a publisher, Document Control)", () => {
    for (const who of ["publisher", "docctrl"] as const) {
      const r = both(who, patch(w.dFree, w.fB), pointer(w, w.dFree));
      expect(r.before, who).toBe(`ok:1 / ${w.fB}`);
      expect(r.after, who).toBe(r.before);
    }
  });

  it("REGRESSION: someone with no publish authority is refused on both sides (the publisher tier before; the lock leg now answers first over a foreign checkout)", () => {
    const r = both("engineer", patch(w.dLocked, w.vB), pointer(w, w.dLocked));
    expect(r.before).not.toMatch(/^ok:1/);
    expect(r.after).not.toMatch(/^ok:1/);
    expect(r.before.endsWith(w.vA) && r.after.endsWith(w.vA)).toBe(true);
    // over an unlocked document the publisher tier's own sentence is unchanged
    const f = both("engineer", patch(w.dFree, w.fB));
    expect(f.after).toBe(f.before);
  });

  it("REGRESSION: the service role (no session) is never judged by the guard", () => {
    const r = both("service", patch(w.dLocked, w.vB), pointer(w, w.dLocked));
    expect(r.before).toBe(`ok:1 / ${w.vB}`);
    expect(r.after).toBe(r.before);
  });

  it("REGRESSION: a status-only write over a foreign checkout is not a publish — the lock leg does not judge it", () => {
    const r = both("publisher", `UPDATE documents SET title = 'Retitled' WHERE id = '${w.dLocked}'`);
    expect(r.after).toBe(r.before);
  });

  describe("publish_revision — every path answers exactly as before", () => {
    it("a publisher WITHOUT an override is answered locked_by_other on both sides (nothing written)", () => {
      const r = both("publisher", publishStatus(w.dLocked, w.vA), pointer(w, w.dLocked));
      expect(r.before).toBe(`ok:1 / ${w.vA}`);
      expect(r.after).toBe(r.before);
      const s = both("publisher", publish(w.dLocked, w.vA));
      expect(s.before).toBe("ok:0");
      expect(s.after).toBe("ok:0");
    });

    it("the AUTHORIZED-PUBLISHER OVERRIDE (a reason of 5+ characters) publishes over the checkout on both sides and records REV_LOCK_OVERRIDDEN — the guard recognises publish_revision's own promote", () => {
      const extra = ", p_override_lock := true, p_override_reason := 'field fix needed today'";
      const after = `SELECT (SELECT revision_label FROM document_versions WHERE id = d.current_version_id) || '|' ||
        (SELECT count(*) FROM audit_logs a WHERE a.resource_id = d.id::text AND a.action = 'REV_LOCK_OVERRIDDEN' AND a.details->>'via' = 'override')
        FROM documents d WHERE d.id = '${w.dLocked}';`;
      for (const who of ["publisher", "owner"] as const) {
        const r = both(who, publish(w.dLocked, w.vA, extra), after);
        expect(r.before, `${who} before`).toBe("ok:1 / C|1");
        expect(r.after, `${who} after`).toBe(r.before);
      }
    });

    it("an OVERRIDE REVERT (revertToVersion's door: reverted_from_version_id set, a new label, a reason) publishes over the checkout on both sides and records REV_LOCK_OVERRIDDEN — the revert's row is still this transaction's, on top of the current one", () => {
      const stmt = `SELECT 1 FROM (SELECT publish_revision(p_doc := '${w.dLocked}', p_expected_base := '${w.vA}', p_op_class := 'content',
         p_version := jsonb_build_object('revision_label', 'C', 'file_url', 'p32/la.pdf', 'change_type', 'Minor',
                                         'change_log', 'Reverted to A', 'reverted_from_version_id', '${w.vA}'),
         p_actor := NULL, p_override_lock := true, p_override_reason := 'restore the issued A') AS r) x WHERE x.r->>'status' = 'published'`;
      const after = `SELECT (SELECT revision_label || '|' || COALESCE(reverted_from_version_id::text, 'none') || '|' || COALESCE(supersedes_version_id::text, 'none')
                               FROM document_versions WHERE id = d.current_version_id) || '|' ||
        (SELECT count(*) FROM audit_logs a WHERE a.resource_id = d.id::text AND a.action = 'REV_LOCK_OVERRIDDEN' AND a.details->>'via' = 'override')
        FROM documents d WHERE d.id = '${w.dLocked}';`;
      const r = both("publisher", stmt, after);
      expect(r.before).toBe(`ok:1 / C|${w.vA}|${w.vA}|1`);
      expect(r.after).toBe(r.before);
    });

    it("the override onto a document with NO current revision yet (a first publish over someone else's checkout: supersedes_version_id NULL = the NULL pointer it replaces) publishes on both sides and records it", () => {
      const stmt = `SELECT 1 FROM (SELECT publish_revision(p_doc := '${w.dFirst}', p_expected_base := NULL, p_op_class := 'content',
         p_version := '{"revision_label":"A1","file_url":"p32/1a1.pdf","change_type":"Minor","change_log":"p32 first"}'::jsonb,
         p_actor := NULL, p_override_lock := true, p_override_reason := 'first issue needed today') AS r) x WHERE x.r->>'status' = 'published'`;
      const after = `SELECT (SELECT revision_label || '|' || COALESCE(supersedes_version_id::text, 'none') FROM document_versions WHERE id = d.current_version_id) || '|' ||
        (SELECT count(*) FROM audit_logs a WHERE a.resource_id = d.id::text AND a.action = 'REV_LOCK_OVERRIDDEN' AND a.details->>'via' = 'override')
        FROM documents d WHERE d.id = '${w.dFirst}';`;
      const r = both("publisher", stmt, after);
      expect(r.before).toBe("ok:1 / A1|none|1");
      expect(r.after).toBe(r.before);
    });

    it("the override with too short a reason, and an override by someone with no publish authority, are refused on both sides", () => {
      const short = both("publisher", publish(w.dLocked, w.vA, ", p_override_lock := true, p_override_reason := 'ok'"));
      expect(short.before).toMatch(/^err:23514:publish_revision: publishing over another user's checkout needs a reason/);
      expect(short.after).toBe(short.before);
      const none = both("engineer", publish(w.dLocked, w.vA, ", p_override_lock := true, p_override_reason := 'field fix needed today'"));
      expect(none.before).toMatch(/^err:23514:publish_revision: only a publisher on this library/);
      expect(none.after).toBe(none.before);
    });

    it("Document Control's FORCE publishes over the checkout on both sides and records it", () => {
      const after = `SELECT (SELECT revision_label FROM document_versions WHERE id = d.current_version_id) || '|' ||
        (SELECT count(*) FROM audit_logs a WHERE a.resource_id = d.id::text AND a.action = 'REV_LOCK_OVERRIDDEN' AND a.details->>'via' = 'force')
        FROM documents d WHERE d.id = '${w.dLocked}';`;
      const r = both("docctrl", publish(w.dLocked, w.vA, ", p_force := true"), after);
      expect(r.before).toBe("ok:1 / C|1");
      expect(r.after).toBe(r.before);
    });

    it("the HOLDER's publish lands on both sides; an unlocked document's publish lands on both sides", () => {
      const h = both("holder", publish(w.dLocked, w.vA), pointer(w, w.dLocked));
      expect(h.before).toMatch(/^ok:1 \/ [0-9a-f-]{36}$/);
      expect(h.before).not.toContain(w.vA);
      expect(h.after.split(" / ")[0]).toBe("ok:1");
      const f = both("publisher", publish(w.dFree, w.fA));
      expect(f.before).toBe("ok:1");
      expect(f.after).toBe("ok:1");
    });

    it("a hold still never passes: the publisher override over a held, checked-out document is answered on_hold on both sides", () => {
      const r = both("publisher", publishStatus(w.dHeld, w.hA, ", p_override_lock := true, p_override_reason := 'field fix needed today'"), pointer(w, w.dHeld));
      expect(r.before).toBe(`ok:1 / ${w.hA}`);
      expect(r.after).toBe(r.before);
    });
  });

  describe("the reviewed promote — door (b), unchanged", () => {
    it("finalize_reviewed_promote by a publisher, or Document Control, who does not hold the checkout promotes the reviewed draft on both sides", () => {
      const stmt = `SELECT 1 WHERE finalize_reviewed_promote('${w.dReview}', '${w.r2A}', '${w.rA}', 'B', NULL) = 'promoted'`;
      for (const who of ["publisher", "docctrl"] as const) {
        const r = both(who, stmt, pointer(w, w.dReview));
        expect(r.before, who).toBe(`ok:1 / ${w.r2A}`);
        expect(r.after, who).toBe(r.before);
      }
    });

    it("its three-step fallback (promoteThreeStep's write: the pending draft made current, the pending pointer cleared) lands on both sides", () => {
      const stmt = `UPDATE documents SET current_version_id = '${w.r2A}', rev = 'B', revision = 'B', status = 'Issued', pending_version_id = NULL
                     WHERE id = '${w.dReview}' AND pending_version_id = '${w.r2A}' AND current_version_id = '${w.rA}'`;
      const r = both("publisher", stmt, pointer(w, w.dReview));
      expect(r.before).toBe(`ok:1 / ${w.r2A}`);
      expect(r.after).toBe(r.before);
    });

    it("door (b) cannot be borrowed by a draft not marked in review: a pending draft NOT marked in review, promoted over a foreign checkout, is refused after (admitted before); the holder's promote of it lands on both sides", () => {
      const stmt = `UPDATE documents SET current_version_id = '${w.s2A}', rev = '2A', revision = '2A', pending_version_id = NULL WHERE id = '${w.dStale}'`;
      const r = both("publisher", stmt, pointer(w, w.dStale));
      expect(r.before).toBe(`ok:1 / ${w.s2A}`);
      expect(r.after).toMatch(new RegExp(`^err:42501:.* / ${w.sA}$`));
      const h = both("holder", stmt, pointer(w, w.dStale));
      expect(h.before).toBe(`ok:1 / ${w.s2A}`);
      expect(h.after).toBe(h.before);
    });

    const threeStep = (doc: string, pending: string, current: string) =>
      `UPDATE documents SET current_version_id = '${pending}', rev = 'B', revision = 'B', status = 'Issued', pending_version_id = NULL
        WHERE id = '${doc}' AND pending_version_id = '${pending}' AND current_version_id = '${current}'`;

    it("door (b) cannot be borrowed by a FORGED intake draft (the P32 review's reproduction): a library publisher's own writes — INSERT an in-review 'external' draft naming any intake link id, point the pending pointer at it, promote it — were all admitted before; after, the INSERT and the pointer still land (neither is the guard's), and the promote is refused 42501, nothing moves", () => {
      // (1) the INSERT a publisher may make through PostgREST (document_versions_insert_integrity's publisher limb)
      const ins = both("publisher", `INSERT INTO document_versions (org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by)
        VALUES ('${w.org}', '${w.dLocked}', '2A', 'B', 'in_review', 'external', gen_random_uuid(), 'p32/forged.pdf', 'Major', '${w.uid.publisher}')`);
      expect(ins.before).toBe("ok:1");
      expect(ins.after).toBe("ok:1");
      // (2) + (3) on dForge, whose forged 2A was inserted a day ago (a separate request): the pending pointer, then the promote
      const promote = [`UPDATE documents SET pending_version_id = '${w.g2A}' WHERE id = '${w.dForge}'`, threeStep(w.dForge, w.g2A, w.gA)];
      const r = { before: probeSeq(BEFORE, w, "publisher", promote, pointer(w, w.dForge)), after: probeSeq(AFTER, w, "publisher", promote, pointer(w, w.dForge)) };
      expect(r.before).toBe(`ok:1 / ok:1 / ${w.g2A}`);
      expect(r.after).toMatch(new RegExp(`^ok:1 / err:42501:This document is checked out by Holder Person, .* / ${w.gA}$`));
      // finalize_reviewed_promote is no way round it either
      const f = { before: probeSeq(BEFORE, w, "publisher", [promote[0], `SELECT 1 WHERE finalize_reviewed_promote('${w.dForge}', '${w.g2A}', '${w.gA}', 'B', NULL) = 'promoted'`], pointer(w, w.dForge)),
                  after: probeSeq(AFTER, w, "publisher", [promote[0], `SELECT 1 WHERE finalize_reviewed_promote('${w.dForge}', '${w.g2A}', '${w.gA}', 'B', NULL) = 'promoted'`], pointer(w, w.dForge)) };
      expect(f.before).toBe(`ok:1 / ok:1 / ${w.g2A}`);
      expect(f.after).toMatch(new RegExp(`^ok:1 / err:42501:.* / ${w.gA}$`));
      // the holder's own promote of it is no lock question (the lock leg never judges the holder)
      const h = { before: probeSeq(BEFORE, w, "holder", promote, pointer(w, w.dForge)), after: probeSeq(AFTER, w, "holder", promote, pointer(w, w.dForge)) };
      expect(h.after).toBe(h.before);
    });

    it("door (b) cannot be borrowed by a FORGED intake draft with no creator that names a REAL link of the org, on a document outside that link's scope (neither authored by it nor assigned to it): admitted before, refused 42501 after", () => {
      const r = both("publisher", threeStep(w.dOut, w.o2A, w.oA), pointer(w, w.dOut));
      expect(r.before).toBe(`ok:1 / ${w.o2A}`);
      expect(r.after).toMatch(new RegExp(`^err:42501:.* / ${w.oA}$`));
    });

    it("REGRESSION: a GENUINE external submission (no member as creator, 'external', the link that authored the document — or the one it is assigned to), approved from the Intake tab by a publisher who does not hold the checkout (finalize_reviewed_promote under a roster-free policy, IntakePanel's approve), promotes on both sides", () => {
      for (const [doc, pend, cur] of [[w.dIntake, w.i2A, w.iA], [w.dAssigned, w.as2A, w.asA]] as const) {
        const stmt = `SELECT 1 WHERE finalize_reviewed_promote('${doc}', '${pend}', '${cur}', 'B', NULL) = 'promoted'`;
        const r = both("publisher", stmt, pointer(w, doc));
        expect(r.before, doc).toBe(`ok:1 / ${pend}`);
        expect(r.after, doc).toBe(r.before);
        // and its three-step fallback
        const t = both("publisher", threeStep(doc, pend, cur), pointer(w, doc));
        expect(t.before, doc).toBe(`ok:1 / ${pend}`);
        expect(t.after, doc).toBe(t.before);
      }
      // the door's own row, creator NULL (the live table, which enforces no NOT NULL there — SEC-22)
      const nullCreator = `ALTER TABLE document_versions ALTER COLUMN created_by DROP NOT NULL; UPDATE document_versions SET created_by = NULL WHERE id = '${w.i2A}';`;
      const stmt = `SELECT 1 WHERE finalize_reviewed_promote('${w.dIntake}', '${w.i2A}', '${w.iA}', 'B', NULL) = 'promoted'`;
      const n = { before: probeSeq(BEFORE, w, "publisher", [stmt], pointer(w, w.dIntake), nullCreator),
                  after: probeSeq(AFTER, w, "publisher", [stmt], pointer(w, w.dIntake), nullCreator) };
      expect(n.before).toBe(`ok:1 / ${w.i2A}`);
      expect(n.after).toBe(n.before);
    });

    it("the remainder DCK-16 records: a publisher's own INSERT of a member-less 'external' draft naming the link that already scopes the document (creator the link's id, or NULL) is admitted on both sides (the client INSERT policy on document_versions, projects-owned) — shaped as the door's, its promote is door (b)'s, which the database cannot tell apart", () => {
      const ins = (creator: string) => `INSERT INTO document_versions (org_id, record_id, revision_label, base_rev, review_state, provenance, intake_link_id, file_url, change_type, created_by)
        VALUES ('${w.org}', '${w.dIntake}', '3A', 'B', 'in_review', 'external', '${w.link}', 'p32/forged-scoped.pdf', 'Major', ${creator})`;
      const a = both("publisher", ins(`'${w.link}'`));
      expect(a.before).toBe("ok:1");
      expect(a.after).toBe("ok:1");
      const dropNotNull = "ALTER TABLE document_versions ALTER COLUMN created_by DROP NOT NULL;";
      const b = { before: probeSeq(BEFORE, w, "publisher", [ins("NULL")], undefined, dropNotNull), after: probeSeq(AFTER, w, "publisher", [ins("NULL")], undefined, dropNotNull) };
      expect(b.before).toBe("ok:1");
      expect(b.after).toBe("ok:1");
    });

    it("door (a) cannot be borrowed by a direct write: a revision made by the same person in an EARLIER request is not this transaction's, so the write is refused after", () => {
      // vB was created by the publisher a day ago, on top of A
      const r = both("publisher", patch(w.dLocked, w.vB));
      expect(r.before).toBe("ok:1");
      expect(r.after).toMatch(/^err:42501:/);
    });
  });
});

describe.skipIf(skip !== null)("20261245 pasted as ONE script, as the SQL editor sends it", () => {
  const SCRATCH = "mos_dc_p32_paste";
  const paste = (db: string) => {
    const r = runPsql(mosDb().conn!, db, "postgres", { sql: mig(FILE) });
    return r;
  };
  const rows = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });

  it("on a copy put back to 20261193's guard: every probe true, the six inventory rows are counts (the seeded world's forged no-creator draft outside its link's scope among them), and a re-paste is clean", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, `${guardOf(BASE)}\nREVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;`);
      const before = Number(admin(SCRATCH, `SELECT count(*) FROM documents WHERE checked_out_by IS NOT NULL`));
      for (let pass = 0; pass < 2; pass++) {
        const r = paste(SCRATCH);
        expect(r.errors, r.stderr).toEqual([]);
        const all = rows(r.stdout);
        const probes = all.filter((x) => x.ok !== "");
        const inventory = all.filter((x) => x.ok === "");
        expect(probes.length, `pass ${pass}`).toBe(7);
        expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
        expect(probes.every((p) => p.n === "")).toBe(true);
        expect(inventory.length).toBe(6);
        expect(inventory.every((x) => /^\d+$/.test(x.n)), JSON.stringify(inventory)).toBe(true);
        expect(Number(inventory[0].n)).toBe(before);
        expect(Number(inventory[1].n) + Number(inventory[2].n)).toBe(before);
        // dOut's pending 2A (no creator, the real link, a document outside its scope) is counted; the genuine ones are not
        expect(Number(inventory[5].n)).toBeGreaterThanOrEqual(1);
        expect(Number(inventory[5].n)).toBeLessThanOrEqual(Number(inventory[3].n));
      }
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });

  it("the prerequisite refuses on a database whose guard is 20261185's (no REV-28 block) and changes nothing", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, guardOf("20261185_dc_roundF_status_into_force_issue.sql"));
      const src = () => admin(SCRATCH, `SELECT md5(prosrc) FROM pg_proc WHERE proname = 'enforce_document_publish_guard'`);
      const was = src();
      const r = paste(SCRATCH);
      expect(r.stderr).toContain("20261245 needs 20261193 (the REV-28 first-issue block in the publish guard) pasted first; nothing was changed.");
      expect(src()).toBe(was);
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });
});
