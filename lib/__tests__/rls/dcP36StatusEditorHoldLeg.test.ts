// document-control Round G — P36 STATUS EDITOR PARITY III: 20261253 at
// RUNTIME on the replayed database (the I-17 harness; `npm run test:db`).
//
//   REV-36 (1): enforce_document_publish_guard returned for a controller
//           BEFORE its hold check, so Document Control's write taking a held
//           document into Superseded (a script, or a status editor whose
//           pre-write read missed a hold) passed unrefused and unrecorded;
//           entry into Void is not advancing, so a hold refused it for
//           nobody. 20261253 adds one block: a status change into Superseded
//           or Void, over an active hold, is refused — a controller included
//           (and into Void anyone) — unless the
//           transaction-local flag a recording function sets names it. The
//           single doors that DO retire a held document for Document Control
//           (a split's / merge's supersession of a held source, a reversal's
//           park of a held sheet — HLD-2's explicit proceed) now write it
//           through retire_over_hold: the same write, under the flag,
//           recorded as REV_HOLD_OVERRIDDEN.
//
// Every statement runs on BOTH sides of the paste, in a transaction that is
// rolled back: "before" is a copy of the replay with 20261245's guard (the
// newest body this file re-creates) put back and retire_over_hold dropped;
// "after" is the replay itself, which ran 20261253. What works today for a
// legitimate user answers the same on both sides (REGRESSION FIRST); only a
// retirement over an active hold outside a recorded pass changes from
// admitted to refused.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, mosDb, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const AFTER = REPLAY_DB;
const BEFORE = "mos_dc_p36_before";
const FILE = "20261253_dc_roundG_status_editor_hold_leg.sql";
const BASE = "20261245_dc_roundG_publish_guard_lock_leg.sql";
const mig = (f: string) => readFileSync(join(process.cwd(), "supabase", "migrations", f), "utf8");
const GUARD_HEAD = "CREATE OR REPLACE FUNCTION enforce_document_publish_guard()";
const guardOf = (f: string) => {
  const s = mig(f);
  const a = s.indexOf(GUARD_HEAD);
  return s.slice(a, s.indexOf("\n$$;", a) + "\n$$;".length);
};
const PUT_BACK_HEAD = "CREATE OR REPLACE FUNCTION put_back_retired_issue(";
const putBackOf = (f: string) => {
  const s = mig(f);
  const a = s.indexOf(PUT_BACK_HEAD);
  return s.slice(a, s.indexOf("\n$$;", a) + "\n$$;".length);
};
/** "before": 20261245's guard, 20261192's put_back_retired_issue (no re-entry limb), no retire_over_hold. */
const PUT_BACK_BASE = [
  `${guardOf(BASE)}\nREVOKE ALL ON FUNCTION enforce_document_publish_guard() FROM PUBLIC, anon, authenticated, service_role;`,
  putBackOf("20261192_dc_roundF_null_prior_status_put_back.sql"),
  "DROP FUNCTION IF EXISTS retire_over_hold(uuid, text, text, timestamptz, text);",
].join("\n");

const ROLES = { admin: "Admin", docctrl: "DocCtrl", publisher: "Drafter", owner: "Viewer", engineer: "Engineer-2" } as const;
type Member = keyof typeof ROLES;
type Who = Member | "service";

const ids = () => ({
  org: randomUUID(), lib: randomUUID(),
  // dHeld: Issued at A, an active hold
  dHeld: randomUUID(), hA: randomUUID(), hold: randomUUID(),
  // dHeld2: Issued at A, an active hold (the flag must not reach it)
  dHeld2: randomUUID(), h2A: randomUUID(), hold2: randomUUID(),
  // dFree: Issued at A, no hold
  dFree: randomUUID(), fA: randomUUID(),
  // dReleased: Issued at A, a hold that was released
  dReleased: randomUUID(), rA: randomUUID(), holdR: randomUUID(),
  // dDraftHeld: a held Draft (no revision)
  dDraftHeld: randomUUID(), holdD: randomUUID(),
  // dArchHeld: Archived from Issued at A, an active hold
  dArchHeld: randomUUID(), aA: randomUUID(), holdA: randomUUID(),
  // dSupHeld: Superseded from Issued at A, an active hold
  dSupHeld: randomUUID(), sA: randomUUID(), holdS: randomUUID(),
  uid: Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomUUID()])) as Record<Member, string>,
});
type World = ReturnType<typeof ids>;

function seed(db: string, w: World): void {
  const u = w.uid;
  const tag = w.org.slice(0, 8);
  admin(db, `
    INSERT INTO orgs (id, name, type) VALUES ('${w.org}', 'P36 ${tag}', 'business');
    ${(Object.keys(ROLES) as Member[]).map((k) => `
    INSERT INTO auth.users (id, email, aud, role) VALUES ('${u[k]}', '${k}-${tag}@p36.test', 'authenticated', 'authenticated');
    INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${u[k]}', '${k}-${tag}@p36.test', '${k}', '${w.org}');
    INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${w.org}', '${u[k]}', '${k}-${tag}@p36.test', '${ROLES[k]}', ARRAY[]::text[], 'active');`).join("")}
    INSERT INTO libraries (id, org_id, name, type, acl_index) VALUES ('${w.lib}', '${w.org}', 'P36', 'documents',
      '{"allow":{"users":{"publish":["${u.publisher}"]}}}'::jsonb);
    INSERT INTO documents (id, org_id, library_id, title, document_number, status, owner_user_id) VALUES
      ('${w.dHeld}',     '${w.org}', '${w.lib}', 'Held',     'P36-H-${tag}', 'Draft', '${u.owner}'),
      ('${w.dHeld2}',    '${w.org}', '${w.lib}', 'Held2',    'P36-H2-${tag}', 'Draft', '${u.owner}'),
      ('${w.dFree}',     '${w.org}', '${w.lib}', 'Free',     'P36-F-${tag}', 'Draft', '${u.owner}'),
      ('${w.dReleased}', '${w.org}', '${w.lib}', 'Released', 'P36-R-${tag}', 'Draft', '${u.owner}'),
      ('${w.dDraftHeld}','${w.org}', '${w.lib}', 'DraftH',   'P36-D-${tag}', 'Draft', '${u.owner}'),
      ('${w.dArchHeld}', '${w.org}', '${w.lib}', 'ArchH',    'P36-A-${tag}', 'Draft', '${u.owner}'),
      ('${w.dSupHeld}',  '${w.org}', '${w.lib}', 'SupH',     'P36-S-${tag}', 'Draft', '${u.owner}');
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, change_type, created_by, created_at) VALUES
      ('${w.hA}', '${w.org}', '${w.dHeld}', 'A', 'p36/${tag}/ha.pdf', 'Minor', '${u.publisher}', now() - interval '2 days'),
      ('${w.h2A}', '${w.org}', '${w.dHeld2}', 'A', 'p36/${tag}/h2a.pdf', 'Minor', '${u.publisher}', now() - interval '2 days'),
      ('${w.fA}', '${w.org}', '${w.dFree}', 'A', 'p36/${tag}/fa.pdf', 'Minor', '${u.publisher}', now() - interval '2 days'),
      ('${w.rA}', '${w.org}', '${w.dReleased}', 'A', 'p36/${tag}/ra.pdf', 'Minor', '${u.publisher}', now() - interval '2 days'),
      ('${w.aA}', '${w.org}', '${w.dArchHeld}', 'A', 'p36/${tag}/aa.pdf', 'Minor', '${u.publisher}', now() - interval '2 days'),
      ('${w.sA}', '${w.org}', '${w.dSupHeld}', 'A', 'p36/${tag}/sa.pdf', 'Minor', '${u.publisher}', now() - interval '2 days');
    UPDATE documents SET current_version_id = '${w.hA}', status = 'Issued', rev = 'A' WHERE id = '${w.dHeld}';
    UPDATE documents SET current_version_id = '${w.h2A}', status = 'Issued', rev = 'A' WHERE id = '${w.dHeld2}';
    UPDATE documents SET current_version_id = '${w.fA}', status = 'Issued', rev = 'A' WHERE id = '${w.dFree}';
    UPDATE documents SET current_version_id = '${w.rA}', status = 'Issued', rev = 'A' WHERE id = '${w.dReleased}';
    UPDATE documents SET current_version_id = '${w.aA}', status = 'Issued', rev = 'A' WHERE id = '${w.dArchHeld}';
    UPDATE documents SET current_version_id = '${w.sA}', status = 'Issued', rev = 'A' WHERE id = '${w.dSupHeld}';
    UPDATE documents SET status = 'Archived' WHERE id = '${w.dArchHeld}';
    UPDATE documents SET status = 'Superseded', superseded_at = now(), superseded_by_user = '${u.docctrl}', supersession_reason = 'seed' WHERE id = '${w.dSupHeld}';
    INSERT INTO document_holds (id, org_id, document_id, reason, notes, opened_by) VALUES
      ('${w.hold}',  '${w.org}', '${w.dHeld}',      'Other', 'p36 harness', '${u.docctrl}'),
      ('${w.hold2}', '${w.org}', '${w.dHeld2}',     'Other', 'p36 harness', '${u.docctrl}'),
      ('${w.holdR}', '${w.org}', '${w.dReleased}',  'Other', 'p36 harness', '${u.docctrl}'),
      ('${w.holdD}', '${w.org}', '${w.dDraftHeld}', 'Other', 'p36 harness', '${u.docctrl}'),
      ('${w.holdA}', '${w.org}', '${w.dArchHeld}',  'Other', 'p36 harness', '${u.docctrl}'),
      ('${w.holdS}', '${w.org}', '${w.dSupHeld}',   'Other', 'p36 harness', '${u.docctrl}');
    UPDATE document_holds SET released_at = now(), released_by = '${u.docctrl}', released_reason = 'cleared' WHERE id = '${w.holdR}';`);
}

/** Several statements as `who`, each its own savepointed call (a sequence of PostgREST requests),
 *  in ONE transaction that is rolled back; `after` runs as the superuser before the rollback. */
function probeSeq(db: string, w: World, who: Who, stmts: string[], after?: string): string {
  const { conn } = mosDb();
  const claims = who === "service" ? { role: "service_role" } : { role: "authenticated", sub: w.uid[who] };
  const role = who === "service" ? "service_role" : "authenticated";
  const sql = [
    "BEGIN;",
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
const probe = (db: string, w: World, who: Who, stmt: string, after?: string) => probeSeq(db, w, who, [stmt], after);

const statusOf = (doc: string) => `SELECT COALESCE(status, 'none') FROM documents WHERE id = '${doc}';`;
const setStatus = (doc: string, status: string) => `UPDATE documents SET status = '${status}', updated_at = now() WHERE id = '${doc}'`;
/** What the split / merge saga writes on its source (lib/documentLifecycle/common.ts markSupersededAndLink). */
const supersedeBare = (doc: string, uid: string) =>
  `UPDATE documents SET status = 'Superseded', superseded_at = now(), superseded_by_user = '${uid}', supersession_reason = 'split into new sheets', supersession_moc = 'MOC-36', updated_at = now(), updated_by = '${uid}' WHERE id = '${doc}'`;
const retireOverHold = (doc: string, via = "split") =>
  `SELECT 1 FROM (SELECT retire_over_hold('${doc}', '${via}', 'split into new sheets', now(), 'MOC-36') AS r) x WHERE x.r = 'superseded_over_hold'`;
const overrides = (doc: string) => `SELECT count(*) FROM audit_logs WHERE action = 'REV_HOLD_OVERRIDDEN' AND resource_id = '${doc}';`;
const LEG = /^err:23514:Document has an active hold; a held document can't be superseded or voided here/;

describe.skipIf(skip !== null)("REV-36 (20261253): entry into Superseded / Void over an active hold, before and after the paste", () => {
  let w: World;

  beforeAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
    admin("postgres", `CREATE DATABASE ${BEFORE} TEMPLATE ${AFTER}`);
    admin(BEFORE, PUT_BACK_BASE);
    w = ids();
    seed(BEFORE, w);
    seed(AFTER, w);
  });
  afterAll(() => {
    admin("postgres", `DROP DATABASE IF EXISTS ${BEFORE}`);
  });

  const both = (who: Who, stmt: string, after?: string) => ({ before: probe(BEFORE, w, who, stmt, after), after: probe(AFTER, w, who, stmt, after) });
  const bothSeq = (who: Who, stmts: string[], after?: string) => ({ before: probeSeq(BEFORE, w, who, stmts, after), after: probeSeq(AFTER, w, who, stmts, after) });

  it("the two sides are what they say: the replay carries the hold leg and retire_over_hold, the copy carries 20261245's body without them", () => {
    const has = (db: string) => admin(db, `SELECT prosrc LIKE '%a held document can''''t be superseded or voided here%' FROM pg_proc WHERE proname = 'enforce_document_publish_guard'`);
    expect(has(AFTER)).toBe("t");
    expect(has(BEFORE)).toBe("f");
    expect(admin(AFTER, `SELECT count(*) FROM pg_proc WHERE proname = 'retire_over_hold'`)).toBe("1");
    expect(admin(BEFORE, `SELECT count(*) FROM pg_proc WHERE proname = 'retire_over_hold'`)).toBe("0");
    expect(admin(AFTER, `SELECT prosrc LIKE '%v_reentry := true;%' FROM pg_proc WHERE proname = 'put_back_retired_issue'`)).toBe("t");
    expect(admin(BEFORE, `SELECT prosrc LIKE '%v_reentry%' FROM pg_proc WHERE proname = 'put_back_retired_issue'`)).toBe("f");
    // the lock leg (20261245) is on both sides
    for (const db of [AFTER, BEFORE]) expect(admin(db, `SELECT prosrc LIKE '%IF OLD.checked_out_by IS NOT NULL%insufficient_privilege%' FROM pg_proc WHERE proname = 'enforce_document_publish_guard'`)).toBe("t");
  });

  it("THE DEFECT, closed: Document Control's (and an Admin's) write taking a held Issued document into Superseded was admitted before and is refused after; nothing moves", () => {
    for (const who of ["docctrl", "admin"] as const) {
      const r = both(who, setStatus(w.dHeld, "Superseded"), statusOf(w.dHeld));
      expect(r.before, `${who} before`).toBe("ok:1 / Superseded");
      expect(r.after, `${who} after`).toMatch(LEG);
      expect(r.after.endsWith(" / Issued"), r.after).toBe(true);
    }
  });

  it("Void over an active hold: admitted before for Document Control AND for a library publisher or the owner (entry into Void was not advancing); refused after for each", () => {
    for (const who of ["docctrl", "publisher", "owner"] as const) {
      const r = both(who, setStatus(w.dHeld, "Void"), statusOf(w.dHeld));
      expect(r.before, `${who} before`).toBe("ok:1 / Void");
      expect(r.after, `${who} after`).toMatch(LEG);
      expect(r.after.endsWith(" / Issued"), r.after).toBe(true);
    }
  });

  it("a held Draft (no revision) taken into Superseded or Void by Document Control: admitted before, refused after (a status change into Superseded or Void, from any status)", () => {
    for (const to of ["Superseded", "Void"]) {
      const r = both("docctrl", setStatus(w.dDraftHeld, to), statusOf(w.dDraftHeld));
      expect(r.before).toBe(`ok:1 / ${to}`);
      expect(r.after).toMatch(LEG);
    }
  });

  it("REGRESSION: below a controller, a supersession over a hold is refused on both sides in the publisher tier's OWN words, unchanged (the hold leg does not judge it)", () => {
    const r = both("publisher", setStatus(w.dHeld, "Superseded"), statusOf(w.dHeld));
    expect(r.before).toMatch(/^err:23514:Document has an active hold; release the hold before publishing a new revision\. \/ Issued$/);
    expect(r.after).toBe(r.before);
    // someone with no publish authority: the authority refusal, on both sides
    const e = both("engineer", setStatus(w.dHeld, "Superseded"), statusOf(w.dHeld));
    expect(e.before).not.toMatch(/^ok:1/);
    expect(e.after).toBe(e.before);
  });

  it("REGRESSION: a document with NO active hold (never held, or its hold released) is superseded or voided exactly as before — by Document Control and by a library publisher", () => {
    for (const doc of [w.dFree, w.dReleased]) {
      for (const who of ["docctrl", "publisher"] as const) {
        for (const to of ["Superseded", "Void"]) {
          const r = both(who, setStatus(doc, to), statusOf(doc));
          expect(r.before, `${who} ${to}`).toBe(`ok:1 / ${to}`);
          expect(r.after, `${who} ${to}`).toBe(r.before);
        }
      }
    }
    // the authority refusal for someone with none, unchanged
    const e = both("engineer", setStatus(w.dFree, "Superseded"));
    expect(e.after).toBe(e.before);
  });

  it("REGRESSION: every non-retiring write on a held document lands as before — a title fix, Issued -> Draft — and Archived (not in the ruling) is decided as before for Document Control and a publisher", () => {
    for (const who of ["docctrl", "publisher"] as const) {
      const t = both(who, `UPDATE documents SET title = 'Retitled' WHERE id = '${w.dHeld}'`);
      expect(t.before, who).toBe("ok:1");
      expect(t.after, who).toBe(t.before);
      const d = both(who, setStatus(w.dHeld, "Draft"), statusOf(w.dHeld));
      expect(d.after, who).toBe(d.before);
      const a = both(who, setStatus(w.dHeld, "Archived"), statusOf(w.dHeld));
      expect(a.after, who).toBe(a.before);
    }
    expect(both("docctrl", setStatus(w.dHeld, "Archived"), statusOf(w.dHeld)).after).toBe("ok:1 / Archived");
  });

  it("a move between retired statuses of a held document (Archived -> Superseded, Superseded -> Void) is a status change into Superseded / Void too: admitted before for Document Control, refused after; the publisher tier's own words unchanged where it judged it", () => {
    const a = both("docctrl", setStatus(w.dArchHeld, "Superseded"), statusOf(w.dArchHeld));
    expect(a.before).toBe("ok:1 / Superseded");
    expect(a.after).toMatch(LEG);
    expect(a.after.endsWith(" / Archived"), a.after).toBe(true);
    const s = both("docctrl", setStatus(w.dSupHeld, "Void"), statusOf(w.dSupHeld));
    expect(s.before).toBe("ok:1 / Void");
    expect(s.after).toMatch(LEG);
    expect(s.after.endsWith(" / Superseded"), s.after).toBe(true);
    // a publisher taking the held Archived document into Superseded: the publisher tier's refusal on both sides, unchanged
    const p = both("publisher", setStatus(w.dArchHeld, "Superseded"), statusOf(w.dArchHeld));
    expect(p.before).toMatch(/^err:23514:Document has an active hold; release the hold before publishing a new revision\. \/ Archived$/);
    expect(p.after).toBe(p.before);
    // a write that keeps the status (Superseded -> Superseded, a column fix) is no entry: lands on both sides
    const k = both("docctrl", `UPDATE documents SET supersession_reason = 'fixed', status = 'Superseded' WHERE id = '${w.dSupHeld}'`, statusOf(w.dSupHeld));
    expect(k.before).toBe("ok:1 / Superseded");
    expect(k.after).toBe(k.before);
  });

  it("the recorded doors cover the same moves: retire_over_hold on a held ARCHIVED document lands and records (Archived -> Superseded); put_back_retired_issue's rollback to Void of a held document the caller superseded, forced, lands recorded; its re-supersession from Archived too", () => {
    const viaRpc = `SELECT 1 FROM (SELECT retire_over_hold('${w.dArchHeld}', 'split', 'split into new sheets', now(), 'MOC-36') AS r) x WHERE x.r = 'superseded_over_hold'`;
    expect(probe(AFTER, w, "docctrl", viaRpc, `${statusOf(w.dArchHeld)} ${overrides(w.dArchHeld)}`)).toBe("ok:1 / Superseded / 1");
    expect(probe(AFTER, w, "docctrl", viaRpc,
      `SELECT (details->>'priorStatus') || '|' || (details->>'newStatus') FROM audit_logs WHERE action = 'REV_HOLD_OVERRIDDEN' AND resource_id = '${w.dArchHeld}';`))
      .toBe("ok:1 / Archived|Superseded");
    // the rollback of a supersession back to Void (the source was Void before the door superseded it), over its hold, forced
    const toVoid = (via: string, want = "restored_over_hold") => `SELECT 1 FROM (SELECT put_back_retired_issue('${w.dSupHeld}', 'Void', '${via}', 'rolled back', true, NULL, NULL, NULL, NULL) AS r) x WHERE x.r = '${want}'`;
    for (const via of ["supersede_rollback", "lifecycle_rollback"]) {
      // before: the bare write (Superseded -> Void was not advancing; the hold refused nobody), unrecorded
      expect(probe(BEFORE, w, "docctrl", toVoid(via, "restored"), `${statusOf(w.dSupHeld)} ${overrides(w.dSupHeld)}`), via).toBe("ok:1 / Void / 0");
      expect(probe(AFTER, w, "docctrl", toVoid(via), `${statusOf(w.dSupHeld)} ${overrides(w.dSupHeld)}`), via).toBe("ok:1 / Void / 1");
    }
    // not the caller's own supersession (an Admin rolling back Document Control's), or no force: the bare write, refused after
    expect(probe(AFTER, w, "admin", toVoid("supersede_rollback"), statusOf(w.dSupHeld))).toMatch(LEG);
    expect(probe(AFTER, w, "docctrl", `SELECT put_back_retired_issue('${w.dSupHeld}', 'Void', 'supersede_rollback', 'x', false, NULL, NULL, NULL, NULL)`, statusOf(w.dSupHeld))).toMatch(LEG);
    // the reversal's re-supersession of a source standing at Archived, over its hold, forced: recorded
    const reSup = `SELECT 1 FROM (SELECT put_back_retired_issue('${w.dArchHeld}', 'Superseded', 'reversal_rollback', 'rolled back', true, now(), '${w.uid.docctrl}', 'split into new sheets', 'MOC-36') AS r) x WHERE x.r = 'restored_over_hold'`;
    expect(probe(AFTER, w, "docctrl", reSup, `${statusOf(w.dArchHeld)} ${overrides(w.dArchHeld)}`)).toBe("ok:1 / Superseded / 1");
  });

  it("REGRESSION: the service role (no session) is never judged by the guard", () => {
    for (const to of ["Superseded", "Void"]) {
      const r = both("service", setStatus(w.dHeld, to), statusOf(w.dHeld));
      expect(r.before).toBe(`ok:1 / ${to}`);
      expect(r.after).toBe(r.before);
    }
  });

  it("THE SINGLE DOORS still work for Document Control over a hold, now recorded: before the paste the split / merge source flip is the bare write (retire_over_hold absent: 42883 — the app's fallback); after it, retire_over_hold lands the same write and records REV_HOLD_OVERRIDDEN, and the bare write is refused", () => {
    const cols = `SELECT status || '|' || COALESCE(supersession_reason, '') || '|' || COALESCE(supersession_moc, '') || '|' || (superseded_by_user = '${w.uid.docctrl}')::text FROM documents WHERE id = '${w.dHeld}';`;
    // before: the RPC does not exist (the app's fallback is the bare write, admitted)
    expect(probe(BEFORE, w, "docctrl", retireOverHold(w.dHeld))).toMatch(/^err:42883:/);
    expect(probe(BEFORE, w, "docctrl", supersedeBare(w.dHeld, w.uid.docctrl), cols)).toBe("ok:1 / Superseded|split into new sheets|MOC-36|true");
    // after: the recorded door lands exactly that write, and records the pass
    expect(probe(AFTER, w, "docctrl", retireOverHold(w.dHeld), cols)).toBe("ok:1 / Superseded|split into new sheets|MOC-36|true");
    expect(probe(AFTER, w, "docctrl", retireOverHold(w.dHeld), overrides(w.dHeld))).toBe("ok:1 / 1");
    expect(probe(AFTER, w, "docctrl", retireOverHold(w.dHeld),
      `SELECT (details->>'via') || '|' || (details->>'newStatus') || '|' || (details->>'retiredOverHold') || '|' || jsonb_array_length(details->'holds') FROM audit_logs WHERE action = 'REV_HOLD_OVERRIDDEN' AND resource_id = '${w.dHeld}';`))
      .toBe("ok:1 / split|Superseded|true|1");
    expect(probe(AFTER, w, "docctrl", supersedeBare(w.dHeld, w.uid.docctrl), statusOf(w.dHeld))).toMatch(LEG);
    // an Admin's split / merge too
    expect(probe(AFTER, w, "admin", retireOverHold(w.dHeld, "merge"), statusOf(w.dHeld))).toBe("ok:1 / Superseded");
  });

  it("the reversal's park of a held sheet: the bare park before; retire_over_hold('reversal_park') after — the park's own columns (no MOC written), recorded", () => {
    const park = `UPDATE documents SET status = 'Superseded', superseded_at = now(), superseded_by_user = '${w.uid.docctrl}', supersession_reason = 'Reverted split — wrong sheets', updated_at = now(), updated_by = '${w.uid.docctrl}' WHERE id = '${w.dHeld}'`;
    const cols = `SELECT status || '|' || COALESCE(supersession_reason, '') || '|' || COALESCE(supersession_moc, 'no moc') FROM documents WHERE id = '${w.dHeld}';`;
    expect(probe(BEFORE, w, "docctrl", park, cols)).toBe("ok:1 / Superseded|Reverted split — wrong sheets|no moc");
    expect(probe(AFTER, w, "docctrl", park, cols)).toMatch(LEG);
    const viaRpc = `SELECT 1 FROM (SELECT retire_over_hold('${w.dHeld}', 'reversal_park', 'Reverted split — wrong sheets', now(), 'IGNORED') AS r) x WHERE x.r = 'superseded_over_hold'`;
    expect(probe(AFTER, w, "docctrl", viaRpc, cols)).toBe("ok:1 / Superseded|Reverted split — wrong sheets|no moc");
  });

  it("the recorded door opens for nobody else and for nothing else: a publisher's call is the bare write (refused by the publisher tier, unrecorded); an unheld document's is the bare write (no record); the flag never reaches another held document", () => {
    // a publisher (not Document Control) over a hold: the bare write, refused in the tier's words, nothing recorded
    expect(probe(AFTER, w, "publisher", `SELECT retire_over_hold('${w.dHeld}', 'split', 'x', now(), NULL)`, overrides(w.dHeld)))
      .toMatch(/^err:23514:Document has an active hold; release the hold before publishing a new revision\. \/ 0$/);
    // an unheld document: 'superseded', no record
    expect(probe(AFTER, w, "docctrl", `SELECT retire_over_hold('${w.dFree}', 'split', 'x', now(), NULL)`, overrides(w.dFree))).toBe("ok:1 / 0");
    expect(probe(AFTER, w, "docctrl", `SELECT 1 FROM (SELECT retire_over_hold('${w.dFree}', 'split', 'x', now(), NULL) AS r) x WHERE x.r = 'superseded'`)).toBe("ok:1");
    // the flag names one document for one statement: a bare write on ANOTHER held document in the same transaction is refused
    const seq = probeSeq(AFTER, w, "docctrl", [retireOverHold(w.dHeld), setStatus(w.dHeld2, "Superseded")],
      `SELECT current_setting('app.publish_hold_override', true) || '|' || (SELECT status FROM documents WHERE id = '${w.dHeld2}');`);
    expect(seq).toMatch(/^ok:1 \/ err:23514:Document has an active hold; a held document can't .* \/ \|Issued$/);
    // no session (the service role holds no EXECUTE — DRLS-16), an unknown door, a blank reason: refused, nothing written
    expect(probe(AFTER, w, "service", `SELECT retire_over_hold('${w.dHeld}', 'split', 'x', now(), NULL)`, statusOf(w.dHeld))).toBe("err:42501:permission denied for function retire_over_hold / Issued");
    expect(probe(AFTER, w, "docctrl", `SELECT retire_over_hold('${w.dHeld}', 'bulk_edit', 'x', now(), NULL)`, statusOf(w.dHeld))).toMatch(/^err:23514:retire_over_hold: name the door .* \/ Issued$/);
    expect(probe(AFTER, w, "docctrl", `SELECT retire_over_hold('${w.dHeld}', 'split', '  ', now(), NULL)`, statusOf(w.dHeld))).toMatch(/^err:23514:retire_over_hold: give the supersession's reason\. \/ Issued$/);
    // anon may not execute it
    expect(admin(AFTER, `SELECT has_function_privilege('anon', 'retire_over_hold(uuid, text, text, timestamptz, text)', 'EXECUTE')`)).toBe("f");
  });

  it("REGRESSION: the rollback of a failed split over a hold (put_back_retired_issue, lifecycle_rollback, forced) puts the source back on both sides — after a bare flip before the paste, after retire_over_hold's flip after it", () => {
    const putBack = `SELECT 1 FROM (SELECT put_back_retired_issue('${w.dHeld}', 'Issued', 'lifecycle_rollback', 'rolled back', true, NULL, NULL, NULL, NULL) AS r) x WHERE x.r = 'restored_over_hold'`;
    const before = probeSeq(BEFORE, w, "docctrl", [supersedeBare(w.dHeld, w.uid.docctrl), putBack], statusOf(w.dHeld));
    const after = probeSeq(AFTER, w, "docctrl", [retireOverHold(w.dHeld), putBack], statusOf(w.dHeld));
    expect(before).toBe("ok:1 / ok:1 / Issued");
    expect(after).toBe("ok:1 / ok:1 / Issued");
  });

  it("REGRESSION: a failed REVERSAL's rollback re-supersedes the source it had restored, over the source's hold (put_back_retired_issue, reversal_rollback, the force asked) — admitted bare before, and after the paste a recorded pass (REV_HOLD_OVERRIDDEN, retiredOverHold), never refused", () => {
    // the source as the reversal leaves it before a later step is refused: restored to Issued, the split's supersession fields cleared
    const reSupersede = `SELECT 1 FROM (SELECT put_back_retired_issue('${w.dHeld}', 'Superseded', 'reversal_rollback', 'rolled back', true, now(), '${w.uid.docctrl}', 'split into new sheets', 'MOC-36') AS r) x WHERE x.r IN ('restored', 'restored_over_hold')`;
    const r = both("docctrl", reSupersede, `SELECT status || '|' || COALESCE(supersession_reason, '') FROM documents WHERE id = '${w.dHeld}';`);
    expect(r.before).toBe("ok:1 / Superseded|split into new sheets");
    expect(r.after).toBe(r.before);
    expect(probe(AFTER, w, "docctrl", reSupersede, overrides(w.dHeld))).toBe("ok:1 / 1");
    expect(probe(AFTER, w, "docctrl", reSupersede,
      `SELECT (details->>'via') || '|' || (details->>'retiredOverHold') || '|' || (details->>'newStatus') FROM audit_logs WHERE action = 'REV_HOLD_OVERRIDDEN' AND resource_id = '${w.dHeld}';`))
      .toBe("ok:1 / reversal_rollback|true|Superseded");
    // without the force asked, or on another door, it is the bare write — refused after (the hold leg), as any entry over a hold
    const noForce = `SELECT put_back_retired_issue('${w.dHeld}', 'Superseded', 'reversal_rollback', 'x', false, now(), '${w.uid.docctrl}', 'x', NULL)`;
    expect(probe(AFTER, w, "docctrl", noForce, statusOf(w.dHeld))).toMatch(LEG);
    const otherDoor = `SELECT put_back_retired_issue('${w.dHeld}', 'Superseded', 'lifecycle_rollback', 'x', true, now(), '${w.uid.docctrl}', 'x', NULL)`;
    expect(probe(AFTER, w, "docctrl", otherDoor, statusOf(w.dHeld))).toMatch(LEG);
    // below a controller nothing changes: the publisher tier refuses it on both sides, in its own words
    const pub = both("publisher", `SELECT put_back_retired_issue('${w.dHeld}', 'Superseded', 'reversal_rollback', 'x', true, now(), '${w.uid.publisher}', 'x', NULL)`);
    expect(pub.before).toMatch(/^err:23514:Document has an active hold; release the hold before publishing a new revision\.$/);
    expect(pub.after).toBe(pub.before);
    // an unheld source: the bare write on both sides, nothing recorded
    const free = `SELECT 1 FROM (SELECT put_back_retired_issue('${w.dFree}', 'Superseded', 'reversal_rollback', 'x', true, now(), '${w.uid.docctrl}', 'x', NULL) AS r) x WHERE x.r = 'restored'`;
    const f = both("docctrl", free, overrides(w.dFree));
    expect(f.before).toBe("ok:1 / 0");
    expect(f.after).toBe(f.before);
  });

  it("REGRESSION: put_back_retired_issue's other doors answer the same on both sides — the un-archive (to Issued, to Draft) and a supersede rollback of a held retirement", () => {
    for (const stmt of [
      `SELECT put_back_retired_issue('${w.dArchHeld}', 'Issued', 'unarchive', 'restored', true)`,
      `SELECT put_back_retired_issue('${w.dArchHeld}', 'Draft', 'unarchive', 'restored', true)`,
      `SELECT put_back_retired_issue('${w.dSupHeld}', 'Issued', 'supersede_rollback', 'rolled back', true, NULL, NULL, NULL, NULL)`,
    ]) {
      const r = both("docctrl", stmt, `${statusOf(w.dArchHeld)} ${statusOf(w.dSupHeld)} ${overrides(w.dArchHeld)} ${overrides(w.dSupHeld)}`);
      expect(r.after, stmt).toBe(r.before);
    }
  });

  it("REGRESSION: the un-supersede / un-void and the hold's own release are untouched: Document Control releasing the hold, then superseding, lands on both sides", () => {
    const r = bothSeq("docctrl", [
      `UPDATE document_holds SET released_at = now(), released_by = '${w.uid.docctrl}', released_reason = 'cleared' WHERE id = '${w.hold}'`,
      setStatus(w.dHeld, "Superseded"),
    ], statusOf(w.dHeld));
    expect(r.before).toBe(r.after);
    expect(r.after.endsWith(" / Superseded"), r.after).toBe(true);
  });
});

describe.skipIf(skip !== null)("20261253 pasted as ONE script, as the SQL editor sends it", () => {
  const SCRATCH = "mos_dc_p36_paste";
  const paste = (db: string) => runPsql(mosDb().conn!, db, "postgres", { sql: mig(FILE) });
  const rows = (stdout: string) => stdout.split("\n").filter((l) => l.length > 0).map((l) => {
    const [check, ok, n] = l.split("|");
    return { check, ok, n };
  });

  it("on a copy put back to 20261245's guard (retire_over_hold absent): every probe true, the four inventory rows are counts, and a re-paste is clean", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, PUT_BACK_BASE);
      const overridesBefore = Number(admin(SCRATCH, `SELECT count(*) FROM audit_logs WHERE action = 'REV_HOLD_OVERRIDDEN'`));
      for (let pass = 0; pass < 2; pass++) {
        const r = paste(SCRATCH);
        expect(r.errors, r.stderr).toEqual([]);
        const all = rows(r.stdout);
        const probes = all.filter((x) => x.ok !== "");
        const inventory = all.filter((x) => x.ok === "");
        expect(probes.length, `pass ${pass}`).toBe(10);
        expect(probes.filter((p) => p.ok !== "t"), JSON.stringify(probes)).toEqual([]);
        expect(probes.every((p) => p.n === "")).toBe(true);
        expect(inventory.length).toBe(4);
        expect(inventory.every((x) => /^\d+$/.test(x.n)), JSON.stringify(inventory)).toBe(true);
        expect(Number(inventory[1].n)).toBeLessThanOrEqual(Number(inventory[0].n));
        expect(Number(inventory[3].n)).toBe(overridesBefore);
      }
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });

  it("the prerequisite refuses on a database whose guard is 20261193's (no lock leg) and changes nothing", () => {
    admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    admin("postgres", `CREATE DATABASE ${SCRATCH} TEMPLATE ${AFTER}`);
    try {
      admin(SCRATCH, `${guardOf("20261193_dc_roundF_ifc_rev_up_first_issue.sql")}\nDROP FUNCTION IF EXISTS retire_over_hold(uuid, text, text, timestamptz, text);`);
      const src = () => admin(SCRATCH, `SELECT md5(prosrc) FROM pg_proc WHERE proname = 'enforce_document_publish_guard'`);
      const was = src();
      const r = paste(SCRATCH);
      expect(r.stderr).toContain("20261253 needs 20261245 (the checkout lock leg in the publish guard) pasted first; nothing was changed.");
      expect(src()).toBe(was);
      expect(admin(SCRATCH, `SELECT count(*) FROM pg_proc WHERE proname = 'retire_over_hold'`)).toBe("0");
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${SCRATCH}`);
    }
  });
});
