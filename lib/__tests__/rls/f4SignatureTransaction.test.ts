// drafting-flow EVID-11 done-whens 2–4 — F4 SIGNATURE TRANSACTION (20261269)
// asserted at RUNTIME on the replayed PostgreSQL 16, each statement as
// PostgREST sends it (role `service_role` for the signing route; role
// `authenticated` with the signer's claims for the browser's roster write).
//
// Everything runs in a COPY of the replay database (CREATE DATABASE …
// TEMPLATE), dropped afterwards: no row is left in the shared one.
//
//   * The file re-pastes cleanly, twice; every probe answers true; the
//     reconciliation counts before equal those after (the paste writes no row).
//   * A/B, on success: TODAY's writes (the route's service-role insert and
//     checked audit insert, then the browser's roster UPDATE as the signer)
//     and the RPC's writes (record_signature_transaction, one call) produce
//     the same e_signatures row, the same audit row (actor_kind included) and
//     the same roster row — for a read-and-understood acknowledgment (both
//     filter branches), a review sign-off, and an unpaired signature.
//   * Authority parity: every roster write today's path refuses, the RPC
//     refuses with the same answer (no row → P0002 / the guard's 23514) —
//     a voided acknowledgment, another person's roster row, a row in a
//     workspace the signer is not an active member of, the draft's author,
//     a standby alternate, an already-signed row — and then NOTHING is left:
//     no signature, no audit row (today's path leaves the signature behind,
//     which the reconciliation reports: EVID-11 reproduced).
//   * A refused audit mirror is kept in the outbox in the same transaction
//     (DEC-109) and the signature stands with the route's warning; an outbox
//     that refuses too undoes everything.
//   * Only the service role executes it; a caller carrying a user JWT is
//     refused; before the paste the call answers 42883 (PGRST202).
//   * The reconciliation (lib/signatureReconciliation.ts — held verbatim in
//     the migration) finds each kind of orphan, and nothing else.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { admin, asCaller, mosDb, selectAs, seedOrg, skipReason, type Caller, type SeededMember } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";
import { SIGNATURE_ORPHAN_CHECKS, orphanIdsSql } from "@/lib/signatureReconciliation";

const skip = skipReason();
const FILE = "20261269_df_roundG_signature_transaction.sql";
const SERVICE: Caller = { role: "service_role" };
const RPC = "record_signature_transaction";

let db = "";

function paste(): { probes: string[]; inventory: string[] } {
  const { conn } = mosDb();
  const r = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "supabase", "migrations", FILE), stopOnError: true });
  expect(r.ok, `${FILE}: ${r.error ?? r.stderr ?? ""}`).toBe(true);
  const rows = r.stdout.split("\n").filter((l) => /\|[tf]?\|[^|]*$/.test(l));
  return { probes: rows.filter((l) => /\|[tf]\|$/.test(l)), inventory: rows.filter((l) => /\|\|.+$/.test(l)) };
}

const jsonb = (v: unknown) => `${dollarQuote(JSON.stringify(v))}::jsonb`;

/** The two rows the signing route builds (app/api/signatures/sign — the
 *  route's own A/B pin, lib/__tests__/f4SignatureTransaction.test.ts, proves
 *  it sends these same objects to the RPC and to its fallback inserts). */
function routeRows(o: { org: string; type: string; resource: string; version: string | null; intent: string; statement: string; signer: SeededMember; name: string; role: string; at: string }) {
  const signature = {
    org_id: o.org, resource_type: o.type, resource_id: o.resource,
    document_version_id: o.version, content_hash: o.version ? "sha-stored" : null,
    intent: o.intent, statement: o.statement,
    signer_user_id: o.signer.uid, signer_name: o.name, signer_role: o.role, signer_email: o.signer.email,
    signature_image: null, user_agent: "vitest", signed_at: o.at,
    reauth_method: "password", reauth_at: o.at,
    metadata: { reauth: { method: "password", at: o.at, provider: "email" }, minted_by: "api/signatures/sign" },
  };
  const audit = (signatureId: string | null) => ({
    action: "ESIGNATURE_CAPTURED", resource_id: o.resource, resource_type: o.type, org_id: o.org,
    user_id: o.signer.uid, user_email: o.signer.email, user_role: o.role,
    details: { intent: o.intent, statement: o.statement, signerName: o.name, signatureId, documentVersionId: o.version, reauthMethod: "password" },
  });
  return { signature, audit };
}

/** The trail check as first written (one NOT EXISTS with an OR inside) — kept
 *  here only to prove the index-friendly rewrite answers the same. */
const OLD_TRAIL = `SELECT s.org_id, s.id FROM e_signatures s
 WHERE NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.org_id = s.org_id
                      AND (a.details ->> 'signatureId' = s.id::text
                           OR (NOT (a.details ? 'signatureId') AND lower(a.resource_id) = s.resource_id::text
                               AND a.user_id = s.signer_user_id AND a.details ->> 'intent' = s.intent)))
   AND NOT EXISTS (SELECT 1 FROM audit_dead_letters d
                    WHERE d.action = 'ESIGNATURE_CAPTURED' AND d.org_id = s.org_id
                      AND d.entry -> 'row' -> 'details' ->> 'signatureId' = s.id::text)
   AND NOT EXISTS (SELECT 1 FROM audit_logs a
                    WHERE a.action = 'AUDIT_DEAD_LETTER' AND a.org_id = s.org_id
                      AND a.details -> 'lost' -> 'details' ->> 'signatureId' = s.id::text)`;

const SIG_COLS = "org_id, resource_type, resource_id, document_version_id, content_hash, intent, statement, signer_user_id, signer_name, signer_role, signer_email, signature_image, user_agent, signed_at, reauth_method, reauth_at, metadata";
const AUDIT_COLS = "action, resource_id, resource_type, org_id, user_id, user_email, user_role, details";

/** TODAY: the route's two service-role inserts (as PostgREST forms them). */
function todaySignature(rows: ReturnType<typeof routeRows>): string {
  const id = selectAs(db, SERVICE, `INSERT INTO e_signatures (${SIG_COLS}) SELECT ${SIG_COLS} FROM jsonb_populate_record(NULL::e_signatures, ${jsonb(rows.signature)}) RETURNING id`)[0];
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  expect(asCaller(db, SERVICE, `INSERT INTO audit_logs (${AUDIT_COLS}) SELECT ${AUDIT_COLS} FROM jsonb_populate_record(NULL::audit_logs, ${jsonb(rows.audit(id))})`)).toEqual({ ok: true, rows: 1 });
  return id;
}

type Tx = { signature: { id: string }; paired: { kind: string; rosterIds: string[] } | null; auditError: string | null };
const rpcSql = (rows: ReturnType<typeof routeRows>, pair: unknown, at: string | null) =>
  `SELECT ${RPC}(${jsonb(rows.signature)}, ${jsonb(rows.audit(null))}, ${pair === null ? "NULL" : jsonb(pair)}, ${at === null ? "NULL" : `'${at}'`})`;
/** AFTER the paste: the route's one call. */
function viaRpc(rows: ReturnType<typeof routeRows>, pair: unknown, at: string | null): Tx {
  const out = selectAs(db, SERVICE, `${rpcSql(rows, pair, at)}::text`);
  return JSON.parse(out[0]) as Tx;
}

const one = (sql: string) => admin(db, sql);
const count = (sql: string) => Number(one(sql));
const sigJson = (id: string) => one(`SELECT (to_jsonb(s) - 'id' - 'resource_id' - 'document_version_id' - 'statement')::text FROM e_signatures s WHERE s.id = '${id}'`);
const auditJson = (sigId: string) => one(`SELECT (to_jsonb(a) - 'id' - 'timestamp' - 'resource_id' || jsonb_build_object('details', a.details - 'signatureId' - 'documentVersionId' - 'statement'))::text FROM audit_logs a WHERE a.action = 'ESIGNATURE_CAPTURED' AND a.details ->> 'signatureId' = '${sigId}'`);
const ackJson = (id: string) => one(`SELECT (to_jsonb(r) - 'id' - 'document_id' - 'document_version_id' - 'signature_id')::text FROM document_acknowledgments r WHERE r.id = '${id}'`);
const reviewJson = (id: string) => one(`SELECT (to_jsonb(r) - 'id' - 'document_id' - 'document_version_id' - 'signature_id')::text FROM document_review_signoffs r WHERE r.id = '${id}'`);
const orphans = (orgId: string) => Object.fromEntries(SIGNATURE_ORPHAN_CHECKS.map((c) => [c.key, admin(db, orphanIdsSql(c, orgId)).split("\n").filter(Boolean)]));
const noOrphans = Object.fromEntries(SIGNATURE_ORPHAN_CHECKS.map((c) => [c.key, [] as string[]]));

describe.skipIf(skip !== null)("EVID-11 (F4): the signature, its audit mirror and its roster row in one transaction — 20261269 at runtime", () => {
  let orgId = "";
  let otherOrg = "";
  let m: Record<string, SeededMember> = {};
  const lib = randomUUID();
  const docs = Array.from({ length: 12 }, () => randomUUID());
  const vers = Array.from({ length: 12 }, () => randomUUID());
  const AT = "2026-11-18T10:00:00.123Z";
  const PAIRED = "2026-11-18T10:00:00.456Z";

  const seedDoc = (i: number, author: SeededMember) => admin(db, [
    `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${docs[i]}', '${orgId}', '${lib}', 'p${i}.pdf', 'P${i}', 'P-${docs[i].slice(0, 8)}', '0', 'Draft')`,
    `INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES ('${vers[i]}', '${orgId}', '${docs[i]}', '1A', 'x/p${i}.pdf', '${author.uid}')`,
  ].join(";\n") + ";");
  const ackRow = (i: number, who: SeededMember, status = "pending", org = orgId) => {
    const id = randomUUID();
    admin(db, `INSERT INTO document_acknowledgments (id, org_id, document_id, document_version_id, revision_label, assignee_user_id, assignee_name, status, assigned_at, created_at, updated_at)
               VALUES ('${id}', '${org}', '${docs[i]}', '${vers[i]}', '1A', '${who.uid}', 'Ann', '${status}', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
    return id;
  };
  const reviewRow = (i: number, who: SeededMember, slot = "primary", activated = true) => {
    const id = randomUUID();
    admin(db, `INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, revision_label, reviewer_user_id, reviewer_name, slot, activated, status, assigned_at, updated_at)
               VALUES ('${id}', '${orgId}', '${docs[i]}', '${vers[i]}', '1A', '${who.uid}', 'Rex', '${slot}', ${activated}, 'pending', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')`);
    return id;
  };
  const ackFor = (i: number, who: SeededMember, statement: string) => routeRows({ org: orgId, type: "document", resource: docs[i], version: vers[i], intent: "Acknowledged", statement, signer: who, name: "Ann", role: "Viewer", at: AT });
  const reviewFor = (i: number, who: SeededMember, statement: string) => routeRows({ org: orgId, type: "document_version", resource: vers[i], version: vers[i], intent: "Reviewed", statement, signer: who, name: "Rex", role: "Engineer-1", at: AT });
  /** TODAY's browser roster write (lib/acknowledgments.ts recordAcknowledgment), as the signer. */
  const todayAck = (who: SeededMember, sigId: string, filter: string) =>
    asCaller(db, who.caller, `UPDATE document_acknowledgments SET status = 'acknowledged', signature_id = '${sigId}', acknowledged_at = '${PAIRED}', updated_at = '${PAIRED}' WHERE assignee_user_id = '${who.uid}' AND status = 'pending' AND ${filter} RETURNING id`);
  /** TODAY's browser roster write (lib/reviewControl.ts recordReviewSignoff), as the signer. */
  const todayReview = (who: SeededMember, sigId: string, signoffId: string) =>
    asCaller(db, who.caller, `UPDATE document_review_signoffs SET status = 'signed', signature_id = '${sigId}', signed_at = '${PAIRED}', updated_at = '${PAIRED}' WHERE id = '${signoffId}' AND reviewer_user_id = '${who.uid}' RETURNING id`);
  const sigCount = () => count(`SELECT count(*) FROM e_signatures WHERE org_id = '${orgId}'`);
  const auditCount = () => count(`SELECT count(*) FROM audit_logs WHERE org_id = '${orgId}' AND action = 'ESIGNATURE_CAPTURED'`);
  const refused = (rows: ReturnType<typeof routeRows>, pair: unknown) => asCaller(db, SERVICE, rpcSql(rows, pair, PAIRED));

  beforeAll(() => {
    db = `mos_f4_sig_${process.pid}`;
    admin("postgres", `DROP DATABASE IF EXISTS ${db}`);
    admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${REPLAY_DB}`);
    const s = seedOrg(db, { ann: { role: "Viewer" }, rex: { role: "Engineer-1" }, alt: { role: "Engineer-2" }, author: { role: "Drafter" }, docctrl: { role: "Viewer", roles: ["DocCtrl"] } });
    orgId = s.orgId;
    m = s.m;
    otherOrg = seedOrg(db, { stranger: { role: "Viewer" } }).orgId;
    admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${lib}', '${orgId}', 'Procedures', 'documents')`);
    for (let i = 0; i < docs.length; i++) seedDoc(i, m.author);
  });
  afterAll(() => {
    if (db) { try { admin("postgres", `DROP DATABASE IF EXISTS ${db}`); } catch { /* deleted with the cluster */ } }
  });

  it("re-pastes cleanly, twice (DEC-30 one paste); every probe answers true; the reconciliation counts after equal those before", () => {
    for (let i = 0; i < 2; i++) {
      const { probes, inventory } = paste();
      expect(probes.length, `paste ${i + 1}`).toBe(3);
      for (const p of probes) expect(p.endsWith("|t|"), p).toBe(true);
      expect(inventory.length).toBe(16);
      const before = inventory.filter((l) => l.startsWith("reconciliation (before apply)")).map((l) => l.split("|").pop());
      const after = inventory.filter((l) => l.startsWith("reconciliation (after)")).map((l) => l.split("|").pop());
      expect(before.length).toBe(6);
      expect(after).toEqual(before);
    }
  });

  it("A/B — a read-and-understood acknowledgment (the version branch): the RPC writes today's three rows, the same", () => {
    const a = ackRow(0, m.ann);
    const b = ackRow(1, m.ann);
    // A: today's path — the route's two inserts, then the browser's UPDATE as the signer
    const ra = ackFor(0, m.ann, "I have read and understood Rev 1A");
    const sigA = todaySignature(ra);
    expect(todayAck(m.ann, sigA, `document_id = '${docs[0]}' AND document_version_id = '${vers[0]}'`)).toEqual({ ok: true, rows: 1 });
    // B: the one call
    const rb = ackFor(1, m.ann, "I have read and understood Rev 1A");
    const tx = viaRpc(rb, { kind: "acknowledgment", rosterId: null }, PAIRED);
    expect(tx.paired).toEqual({ kind: "acknowledgment", rosterIds: [b] });
    expect(tx.auditError).toBeNull();
    expect(sigJson(tx.signature.id)).toBe(sigJson(sigA));
    expect(auditJson(tx.signature.id)).toBe(auditJson(sigA));
    expect(auditJson(sigA)).toContain('"actor_kind": "server"');
    expect(ackJson(b)).toBe(ackJson(a));
    expect(one(`SELECT signature_id FROM document_acknowledgments WHERE id = '${b}'`)).toBe(tx.signature.id);
    // the RPC answers the row PostgREST's select("*") would: every column
    expect(Object.keys(tx.signature).sort()).toEqual(one(`SELECT string_agg(column_name, ',' ORDER BY column_name) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'e_signatures'`).split(","));
  });

  it("A/B — the rosterId branch: the same filters, the same rows", () => {
    const a = ackRow(2, m.ann);
    const b = ackRow(3, m.ann);
    const sigA = todaySignature(ackFor(2, m.ann, "ack by roster id"));
    expect(todayAck(m.ann, sigA, `id = '${a}'`)).toEqual({ ok: true, rows: 1 });
    const tx = viaRpc(ackFor(3, m.ann, "ack by roster id"), { kind: "acknowledgment", rosterId: b }, PAIRED);
    expect(tx.paired?.rosterIds).toEqual([b]);
    expect(ackJson(b)).toBe(ackJson(a));
    expect(sigJson(tx.signature.id)).toBe(sigJson(sigA));
  });

  it("A/B — a review sign-off: the RPC writes today's three rows, the same (the guard and the owner stamp judged it as the signer)", () => {
    const a = reviewRow(4, m.rex);
    const b = reviewRow(5, m.rex);
    const sigA = todaySignature(reviewFor(4, m.rex, "Reviewed and found acceptable"));
    expect(todayReview(m.rex, sigA, a)).toEqual({ ok: true, rows: 1 });
    const tx = viaRpc(reviewFor(5, m.rex, "Reviewed and found acceptable"), { kind: "review_signoff", signoffId: b }, PAIRED);
    expect(tx.paired).toEqual({ kind: "review_signoff", rosterIds: [b] });
    expect(sigJson(tx.signature.id)).toBe(sigJson(sigA));
    expect(auditJson(tx.signature.id)).toBe(auditJson(sigA));
    expect(reviewJson(b)).toBe(reviewJson(a));
  });

  it("A/B — an unpaired signature (a ticket's routed sign-off, a declaration, the Formal approvals panel): the same signature and audit rows; no roster row touched", () => {
    const ticket = randomUUID();
    const mk = (statement: string) => routeRows({ org: orgId, type: "ticket", resource: ticket, version: null, intent: "Approved", statement, signer: m.rex, name: "Rex", role: "Engineer-1", at: AT });
    const sigA = todaySignature(mk("Approved for issue"));
    const tx = viaRpc(mk("Approved for issue"), null, PAIRED);
    expect(tx.paired).toBeNull();
    expect(one(`SELECT (to_jsonb(s) - 'id')::text FROM e_signatures s WHERE s.id = '${tx.signature.id}'`)).toBe(one(`SELECT (to_jsonb(s) - 'id')::text FROM e_signatures s WHERE s.id = '${sigA}'`));
    expect(one(`SELECT (to_jsonb(a) - 'id' - 'timestamp' || jsonb_build_object('details', a.details - 'signatureId'))::text FROM audit_logs a WHERE a.details ->> 'signatureId' = '${tx.signature.id}'`))
      .toBe(one(`SELECT (to_jsonb(a) - 'id' - 'timestamp' || jsonb_build_object('details', a.details - 'signatureId'))::text FROM audit_logs a WHERE a.details ->> 'signatureId' = '${sigA}'`));
  });

  it("authority parity — every roster write today's path refuses, the RPC refuses, and then nothing is left (no signature, no audit row)", () => {
    const cases: Array<{ name: string; rows: ReturnType<typeof routeRows>; pair: unknown; today: () => ReturnType<typeof asCaller>; code: string }> = [];
    // a voided acknowledgment (a newer revision replaced it) — EVID-11's failure scenario
    const voided = ackRow(6, m.ann, "void");
    cases.push({ name: "voided ack", rows: ackFor(6, m.ann, "voided"), pair: { kind: "acknowledgment", rosterId: null }, today: () => todayAck(m.ann, randomUUID(), `document_id = '${docs[6]}' AND document_version_id = '${vers[6]}'`), code: "P0002" });
    // another person's roster row, named by id
    const alts = ackRow(7, m.alt);
    cases.push({ name: "another person's ack row", rows: ackFor(7, m.ann, "not mine"), pair: { kind: "acknowledgment", rosterId: alts }, today: () => todayAck(m.ann, randomUUID(), `id = '${alts}'`), code: "P0002" });
    // the signer's own row, but in a workspace they are not an active member of (RLS re-done)
    const foreign = ackRow(8, m.ann, "pending", otherOrg);
    cases.push({ name: "row in a workspace the signer is not a member of", rows: ackFor(8, m.ann, "foreign"), pair: { kind: "acknowledgment", rosterId: foreign }, today: () => todayAck(m.ann, randomUUID(), `id = '${foreign}'`), code: "P0002" });
    // the review roster: not the named reviewer
    const rexRow = reviewRow(9, m.rex);
    cases.push({ name: "not the named reviewer", rows: reviewFor(9, m.alt, "not mine"), pair: { kind: "review_signoff", signoffId: rexRow }, today: () => todayReview(m.alt, randomUUID(), rexRow), code: "P0002" });
    // the draft's author (independent review by default) — the guard
    const authorRow = reviewRow(10, m.author);
    cases.push({ name: "the draft's author", rows: reviewFor(10, m.author, "my own draft"), pair: { kind: "review_signoff", signoffId: authorRow }, today: () => todayReview(m.author, randomUUID(), authorRow), code: "23514" });
    // a standby alternate — the guard
    const standby = reviewRow(11, m.alt, "alternate", false);
    cases.push({ name: "a standby alternate", rows: reviewFor(11, m.alt, "standby"), pair: { kind: "review_signoff", signoffId: standby }, today: () => todayReview(m.alt, randomUUID(), standby), code: "23514" });
    void voided;
    for (const c of cases) {
      const sigs = sigCount();
      const audits = auditCount();
      const r = refused(c.rows, c.pair);
      expect(r.ok, c.name).toBe(false);
      if (!r.ok) expect(r.code, c.name).toBe(c.code);
      expect(sigCount(), c.name).toBe(sigs);
      expect(auditCount(), c.name).toBe(audits);
      // today's browser write is refused the same way (0 rows, or the same guard)
      const t = c.today();
      if (c.code === "P0002") expect(t, c.name).toEqual({ ok: true, rows: 0 });
      else expect(t.ok === false && t.code, c.name).toBe(c.code);
    }
    // an already-signed review row cannot be signed again — the guard, and nothing left
    const signed = reviewRow(4, m.alt);
    const sigX = todaySignature(reviewFor(4, m.alt, "first"));
    expect(todayReview(m.alt, sigX, signed)).toEqual({ ok: true, rows: 1 });
    const sigs = sigCount();
    const again = refused(reviewFor(4, m.alt, "second"), { kind: "review_signoff", signoffId: signed });
    expect(again.ok === false && again.code).toBe("23514");
    expect(sigCount()).toBe(sigs);
  });

  it("EVID-11 reproduced on today's path and closed by the RPC: the voided acknowledgment leaves an orphan signature only on today's path, and the reconciliation finds it", () => {
    const before = orphans(orgId);
    expect(before).toEqual(noOrphans);
    const sigToday = todaySignature(ackFor(6, m.ann, "today, on a voided row"));
    expect(todayAck(m.ann, sigToday, `document_id = '${docs[6]}' AND document_version_id = '${vers[6]}'`)).toEqual({ ok: true, rows: 0 });
    expect(orphans(orgId)).toEqual({ ...noOrphans, acknowledgment_signature_without_roster_row: [sigToday] });
    admin(db, `DELETE FROM audit_logs WHERE details ->> 'signatureId' = '${sigToday}'; DELETE FROM e_signatures WHERE id = '${sigToday}';`);
    expect(orphans(orgId)).toEqual(noOrphans);
  });

  it("a refused audit mirror is kept in the outbox in the same transaction (DEC-109): the signature stands, the route's warning is answered, no orphan", () => {
    const rows = routeRows({ org: orgId, type: "ticket", resource: randomUUID(), version: null, intent: "Witnessed", statement: "witnessed, mirror refused", signer: m.rex, name: "Rex", role: "Engineer-1", at: AT });
    const bad = { ...rows, audit: (id: string | null) => ({ ...rows.audit(id), action: null }) };
    const tx = JSON.parse(selectAs(db, SERVICE, `${rpcSql(bad as unknown as ReturnType<typeof routeRows>, null, PAIRED)}::text`)[0]) as Tx;
    expect(tx.auditError).toMatch(/null value in column "action"/);
    expect(count(`SELECT count(*) FROM e_signatures WHERE id = '${tx.signature.id}'`)).toBe(1);
    expect(one(`SELECT source || '|' || action || '|' || (entry -> 'row' -> 'details' ->> 'signatureId') FROM audit_dead_letters WHERE entry -> 'row' -> 'details' ->> 'signatureId' = '${tx.signature.id}'`))
      .toBe(`server|ESIGNATURE_CAPTURED|${tx.signature.id}`);
    expect(orphans(orgId)).toEqual(noOrphans);
  });

  it("an outbox that refuses too undoes everything: no signature without a trail", () => {
    const rows = routeRows({ org: orgId, type: "ticket", resource: randomUUID(), version: null, intent: "Witnessed", statement: "both refused", signer: m.rex, name: "Rex", role: "Engineer-1", at: AT });
    const bad = { ...rows, audit: (id: string | null) => ({ ...rows.audit(id), action: null }) };
    const sigs = sigCount();
    admin(db, "REVOKE INSERT ON audit_dead_letters FROM service_role;");
    try {
      const r = asCaller(db, SERVICE, rpcSql(bad as unknown as ReturnType<typeof routeRows>, null, PAIRED));
      expect(r.ok).toBe(false);
      // a sentence for the signer (P0001, passed through by the route); the two refusals in the detail
      if (!r.ok) {
        expect(r.code).toBe("P0001");
        expect(r.message).toMatch(/^The audit trail could not record this signature, so it was not kept\. Try again; if it keeps happening, tell your administrator\./);
      }
    } finally {
      admin(db, "GRANT INSERT ON audit_dead_letters TO service_role;");
    }
    expect(sigCount()).toBe(sigs);
  });

  it("only the service role executes it; a signed-in member and anon cannot; a service call carrying a user JWT is refused", () => {
    const rows = ackFor(0, m.ann, "x");
    for (const who of [m.ann.caller, m.docctrl.caller, { role: "anon" } as Caller]) {
      const r = asCaller(db, who, rpcSql(rows, null, PAIRED));
      expect(r.ok === false && r.code, who.role).toBe("42501");
    }
    const sigs = sigCount();
    const jwt = asCaller(db, { role: "service_role", uid: m.ann.uid }, rpcSql(rows, null, PAIRED));
    expect(jwt.ok === false && jwt.code).toBe("42501");
    expect(sigCount()).toBe(sigs);
    // a pair that is not the one its signature signs is refused, nothing written
    const mismatched = asCaller(db, SERVICE, rpcSql(reviewFor(0, m.ann, "y"), { kind: "acknowledgment" }, PAIRED));
    expect(mismatched.ok === false && mismatched.code).toBe("22023");
    expect(sigCount()).toBe(sigs);
    // the schema-health probe the integrator may list: the timestamptz argument refuses its text (22007, invalid datetime) before the body runs
    const probe = asCaller(db, SERVICE, `SELECT ${RPC}('{}'::jsonb, '{}'::jsonb, NULL, 'schema-health-probe')`);
    expect(probe.ok === false && probe.code).toBe("22007");
    expect(sigCount()).toBe(sigs);
  });

  it("before the paste (reversal: the function dropped) the call answers 42883 — the route's cue for today's path", () => {
    const before = `${db}_before`;
    admin("postgres", `DROP DATABASE IF EXISTS ${before}`);
    admin("postgres", `CREATE DATABASE ${before} TEMPLATE ${db}`);
    try {
      admin(before, `DROP FUNCTION public.${RPC}(jsonb, jsonb, jsonb, timestamptz);`);
      const saved = db;
      db = before;
      try {
        const r = asCaller(db, SERVICE, rpcSql(ackFor(0, m.ann, "z"), null, PAIRED));
        expect(r.ok === false && r.code).toBe("42883");
      } finally { db = saved; }
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${before}`);
    }
  });

  it("the reconciliation finds every kind of orphan, and nothing else", () => {
    const o = seedOrg(db, { ann: { role: "Viewer" }, rex: { role: "Engineer-1" }, cy: { role: "Viewer" }, dee: { role: "Viewer" }, eve: { role: "Engineer-2" }, fay: { role: "Viewer" }, gus: { role: "Engineer-3" } });
    const org = o.orgId;
    const d = randomUUID(); const v = randomUUID(); const v2 = randomUUID(); const l = randomUUID(); const t = randomUUID();
    const sig = (who: SeededMember, intent: string, type: string, resource: string, version: string | null) => {
      const id = randomUUID();
      admin(db, `INSERT INTO e_signatures (id, org_id, resource_type, resource_id, document_version_id, intent, statement, signer_user_id, signer_name) VALUES ('${id}', '${org}', '${type}', '${resource}', ${version ? `'${version}'` : "NULL"}, '${intent}', 's', '${who.uid}', 'n')`);
      return id;
    };
    const mirror = (id: string, who: SeededMember) => admin(db, `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('ESIGNATURE_CAPTURED', 'r', 'document', '${org}', '${who.uid}', jsonb_build_object('signatureId', '${id}'))`);
    admin(db, [
      `INSERT INTO libraries (id, org_id, name, type) VALUES ('${l}', '${org}', 'L', 'documents')`,
      `INSERT INTO documents (id, org_id, library_id, name, title, document_number, rev, status) VALUES ('${d}', '${org}', '${l}', 'q.pdf', 'Q', 'Q-1', '0', 'Draft')`,
      `INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES ('${v}', '${org}', '${d}', '1A', 'x/q.pdf', '${o.m.ann.uid}')`,
      `INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES ('${v2}', '${org}', '${d}', '1B', 'x/q2.pdf', '${o.m.ann.uid}')`,
      `INSERT INTO tickets (id, org_id, ticket_id, title, request_type, status, requester_id, history) VALUES ('${t}', '${org}', 'KE-F4-1', 'Gasket', 'Revision', 'PENDING_REVIEW', '${o.m.ann.uid}', '[]'::jsonb)`,
    ].join(";\n") + ";");
    // healthy: a legacy mirror (no signatureId — matched by resource, signer and intent), a recovered dead letter
    const legacy = sig(o.m.ann, "Witnessed", "document", d, null);
    admin(db, `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('ESIGNATURE_CAPTURED', '${d.toUpperCase()}', 'document', '${org}', '${o.m.ann.uid}', '{"intent":"Witnessed","statement":"s","signerName":"n"}'::jsonb)`);
    const recovered = sig(o.m.ann, "Witnessed", "ticket", randomUUID(), null);
    admin(db, `INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details) VALUES ('AUDIT_DEAD_LETTER', '${org}', 'org', '${org}', NULL, jsonb_build_object('lost', jsonb_build_object('details', jsonb_build_object('signatureId', '${recovered}'))))`);
    // orphan 1: a signature with no trail at all
    const silent = sig(o.m.ann, "Witnessed", "ticket", t, null);
    // orphan 2: an acknowledged row whose signature is another person's
    const rexOther = sig(o.m.rex, "Witnessed", "document", d, null); mirror(rexOther, o.m.rex);
    const ackBad = randomUUID();
    admin(db, `INSERT INTO document_acknowledgments (id, org_id, document_id, document_version_id, assignee_user_id, status, signature_id, acknowledged_at) VALUES ('${ackBad}', '${org}', '${d}', '${v}', '${o.m.ann.uid}', 'acknowledged', '${rexOther}', now())`);
    // orphan 3: a signed review row whose signature does not exist
    const revBad = randomUUID();
    admin(db, `INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at) VALUES ('${revBad}', '${org}', '${d}', '${v}', '${o.m.rex.uid}', 'primary', true, 'signed', '${randomUUID()}', now())`);
    // orphan 4: a ticket slot satisfied by a signature that does not exist
    const slotBad = randomUUID();
    admin(db, `INSERT INTO ticket_review_slots (id, org_id, ticket_id, roster_id, slot_kind, mode, primaries, status, content_hash, signature_id, satisfied_at, satisfied_by, satisfied_via) VALUES ('${slotBad}', '${org}', '${t}', '${randomUUID()}', 'technical', 'blocking', ARRAY['${o.m.rex.uid}']::uuid[], 'satisfied', 'h', '${randomUUID()}', now(), '${o.m.rex.uid}', 'primary')`);
    // orphan 5: rex acknowledged (signature + mirror) while his roster row stayed pending — EVID-11
    const rexAck = sig(o.m.rex, "Acknowledged", "document", d, v); mirror(rexAck, o.m.rex);
    admin(db, `INSERT INTO document_acknowledgments (org_id, document_id, document_version_id, assignee_user_id, status) VALUES ('${org}', '${d}', '${v}', '${o.m.rex.uid}', 'pending')`);
    // orphan 6: ann reviewed (signature + mirror) while her sign-off row stayed pending
    const annRev = sig(o.m.ann, "Reviewed", "document_version", v, v); mirror(annRev, o.m.ann);
    admin(db, `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status) VALUES ('${org}', '${d}', '${v}', '${o.m.ann.uid}', 'primary', true, 'pending')`);
    // the two blind spots the first wording of check 5 had (review fix), and the same shape for check 6:
    // 5a. an Acknowledged signature with no version, by a signer on the roster, that no row carries
    const cyAck = sig(o.m.cy, "Acknowledged", "document", d, null); mirror(cyAck, o.m.cy);
    admin(db, `INSERT INTO document_acknowledgments (org_id, document_id, document_version_id, assignee_user_id, status) VALUES ('${org}', '${d}', '${v}', '${o.m.cy.uid}', 'pending')`);
    // 5b. a signature on revision 1B whose signer's pending row is on 1A (the guard refused the pairing pre-paste)
    const deeAck = sig(o.m.dee, "Acknowledged", "document", d, v2); mirror(deeAck, o.m.dee);
    admin(db, `INSERT INTO document_acknowledgments (org_id, document_id, document_version_id, assignee_user_id, status) VALUES ('${org}', '${d}', '${v}', '${o.m.dee.uid}', 'pending')`);
    // 6b. a review signature on draft 1B whose signer's sign-off row is on draft 1A
    const eveRev = sig(o.m.eve, "Reviewed", "document_version", v2, v2); mirror(eveRev, o.m.eve);
    admin(db, `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status) VALUES ('${org}', '${d}', '${v}', '${o.m.eve.uid}', 'primary', true, 'pending')`);
    // 6a. a versionless review signature on draft 1B (the resource names the draft) whose signer's row is on 1A
    const gusRev = sig(o.m.gus, "Reviewed", "document_version", v2, null); mirror(gusRev, o.m.gus);
    admin(db, `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status) VALUES ('${org}', '${d}', '${v}', '${o.m.gus.uid}', 'primary', true, 'pending')`);
    // healthy: a carried acknowledgment and a carried sign-off are never orphans
    const fayAck = sig(o.m.fay, "Acknowledged", "document", d, v); mirror(fayAck, o.m.fay);
    admin(db, `INSERT INTO document_acknowledgments (org_id, document_id, document_version_id, assignee_user_id, status, signature_id, acknowledged_at) VALUES ('${org}', '${d}', '${v}', '${o.m.fay.uid}', 'acknowledged', '${fayAck}', now())`);
    const fayRev = sig(o.m.fay, "Reviewed", "document_version", v2, v2); mirror(fayRev, o.m.fay);
    admin(db, `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id, slot, activated, status, signature_id, signed_at) VALUES ('${org}', '${d}', '${v2}', '${o.m.fay.uid}', 'primary', true, 'signed', '${fayRev}', now())`);
    void legacy; void recovered;
    const sorted = (ids: string[]) => [...ids].sort();
    expect(orphans(org)).toEqual({
      signature_without_audit_trail: [silent],
      acknowledged_roster_without_its_signature: [ackBad],
      signed_review_row_without_its_signature: [revBad],
      satisfied_ticket_slot_without_its_signature: [slotBad],
      acknowledgment_signature_without_roster_row: sorted([rexAck, cyAck, deeAck]),
      review_signature_without_signoff_row: sorted([annRev, eveRev, gusRev]),
    });
    // the index-friendly trail check answers exactly what the first one did
    expect(admin(db, `SELECT q.id FROM (${OLD_TRAIL}) q WHERE q.org_id = '${org}' ORDER BY q.id`).split("\n").filter(Boolean)).toEqual([silent]);
  });

  it("the trail check is index-friendly: no per-workspace nested comparison, and the same answer as before (3,000 signatures)", () => {
    const vol = `${db}_vol`;
    admin("postgres", `DROP DATABASE IF EXISTS ${vol}`);
    admin("postgres", `CREATE DATABASE ${vol} TEMPLATE ${REPLAY_DB}`);
    try {
      const o = seedOrg(vol, { a: { role: "Viewer" } });
      const N = 3000;
      admin(vol, `INSERT INTO e_signatures (org_id, resource_type, resource_id, intent, statement, signer_user_id, signer_name)
                    SELECT '${o.orgId}', 'ticket', gen_random_uuid(), 'Witnessed', 's', '${o.m.a.uid}', 'n' FROM generate_series(1, ${N});
                  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
                    SELECT 'ESIGNATURE_CAPTURED', s.resource_id::text, 'ticket', s.org_id, s.signer_user_id, jsonb_build_object('signatureId', s.id::text, 'intent', s.intent)
                      FROM e_signatures s WHERE s.org_id = '${o.orgId}' AND random() < 0.9;
                  INSERT INTO audit_logs (action, resource_id, resource_type, org_id, user_id, details)
                    SELECT 'ESIGNATURE_CAPTURED', upper(s.resource_id::text), 'ticket', s.org_id, s.signer_user_id, jsonb_build_object('intent', s.intent)
                      FROM e_signatures s WHERE s.org_id = '${o.orgId}' AND random() < 0.05;
                  ANALYZE e_signatures; ANALYZE audit_logs; ANALYZE audit_dead_letters;`);
      const trail = SIGNATURE_ORPHAN_CHECKS.find((c) => c.key === "signature_without_audit_trail")!.sql;
      const removed = (sql: string) => [...admin(vol, `EXPLAIN ANALYZE SELECT COUNT(*) FROM (${sql}) q`).matchAll(/Rows Removed by Join Filter: (\d+)/g)].reduce((n, x) => n + Number(x[1]), 0);
      // the first wording compared every signature with every mirror of its workspace (≈ N × N); this one compares none per row
      expect(removed(OLD_TRAIL)).toBeGreaterThan(N * N / 4);
      expect(removed(trail)).toBeLessThan(N);
      const diff = (a: string, b: string) => admin(vol, `SELECT COUNT(*) FROM ((${a}) EXCEPT (${b})) x`);
      expect([diff(OLD_TRAIL, trail), diff(trail, OLD_TRAIL)]).toEqual(["0", "0"]);
      expect(Number(admin(vol, `SELECT COUNT(*) FROM (${trail}) q`))).toBeGreaterThan(0);
    } finally {
      admin("postgres", `DROP DATABASE IF EXISTS ${vol}`);
    }
  });

  it("the migration holds each reconciliation statement verbatim (before and after the change)", () => {
    const src = readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");
    for (const c of SIGNATURE_ORPHAN_CHECKS) {
      expect(src.split(`(SELECT COUNT(*) FROM (${c.sql}) q)::text`).length - 1, c.key).toBe(2);
      expect(src, c.key).toContain(`'reconciliation (before apply): ${c.label}'`);
      expect(src, c.key).toContain(`'reconciliation (after): ${c.label}'`);
    }
  });
});
