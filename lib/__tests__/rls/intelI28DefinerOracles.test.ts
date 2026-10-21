// projects-and-cost INTK-19 (intelligence I-28 DEFINER ORACLES): 20261224 on
// the replayed database. The brief's rule (the integrator, DEC-90): every
// policy and SECURITY INVOKER caller that calls the uid- or project-taking
// helpers must answer exactly as before for every legitimate reader, proven
// with the SAME queries, per role, before and after the paste; and a client
// role calling a uid-taking form gets an answer only about auth.uid() (or the
// form narrows to service_role and its callers ask a caller-bound wrapper).
//
//   · before = the replay's snapshot taken just before 20261224 (CHECKPOINTS);
//     after = the replay of the whole sequence. One world (two workspaces,
//     every role the policies distinguish, owners at every rung of the
//     effective-owner chain, a suspended owner, a publish grant, ACL denies,
//     a capability policy) is seeded identically into both, and every
//     statement runs as PostgREST runs a request (SET ROLE + the JWT claims)
//     inside a transaction that is rolled back, so no statement sees another's
//     writes.
//   · Policies under test: every one that calls user_can_publish_on_library,
//     user_is_effective_owner, org_capability_allows, acl_index_denies or
//     project_org (18 policies on 13 tables, each with a case), the document
//     read policy through node_visible (a definer that calls
//     user_is_effective_owner in the caller's session), the checkout guards,
//     the review-signoff guard and owner stamp, transmittals_guard (SECURITY
//     INVOKER) and the quality sign-off helpers (definers that ask
//     org_capability_allows_for about OTHER signers).
//   · The doors: a client role asking a bound helper about another person is
//     refused 42501 after the paste (answered before); project_org answers a
//     non-member NULL; org_capability_allows_for is the service role's.
//   · The paste itself, as the SQL editor sends it, on a copy of the
//     snapshot: one result set of 44 rows, every probe true; a re-paste is
//     clean; each live-database precondition blocks only the REVOKE; the
//     apply-order check refuses on a database without the newest bodies, or
//     without 20261137 or 20261136 (each grants authenticated the evaluator).
//   · The never-re-paste rule: 20261199, 20261133 and 20261159 pasted after
//     it BREAK transmittals and roster opening (42501) until it is pasted
//     again (after 20261133, 20261199 first); 20261137 pasted after it only
//     undoes the narrowing.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin, mosDb, skipReason } from "./dbKit";
import { REPLAY_DB } from "./replay";
import { dollarQuote, runPsql } from "./pgHarness";

const skip = skipReason();
const FILE = "20261224_intel_roundG_definer_oracles.sql";
const SQL = readFileSync(join(process.cwd(), "supabase", "migrations", FILE), "utf8");

const ROLES = {
  admin: "Admin", docctrl: "DocCtrl", manager: "Manager", viewer: "Viewer", publisher: "Viewer", owner: "Viewer",
  folderowner: "Viewer", libowner: "Viewer", gone: "Viewer", supervisor: "Viewer", denied: "Engineer-1",
} as const;
type Member = keyof typeof ROLES;
type Who = Member | "outsider" | "anon" | "service";
const WHO: readonly Who[] = ["anon", "outsider", "viewer", "denied", "owner", "folderowner", "libowner", "publisher", "supervisor", "gone", "manager", "docctrl", "admin", "service"];
const NIL = "00000000-0000-0000-0000-000000000000";

const ids = () => ({
  org: randomUUID(), other: randomUUID(), outsider: randomUUID(), team: randomUUID(),
  lib1: randomUUID(), lib2: randomUUID(), folder: randomUUID(),
  d1: randomUUID(), d2: randomUUID(), d3: randomUUID(), d4: randomUUID(), d5: randomUUID(), d6: randomUUID(),
  v1: randomUUID(), v2: randomUUID(), v6: randomUUID(), ack1: randomUUID(), ack2: randomUUID(), hold: randomUUID(), so1: randomUUID(), so2: randomUUID(),
  branch: randomUUID(), tr: randomUUID(), draft: randomUUID(), project: randomUUID(), pdoc: randomUUID(), session: randomUUID(),
  uid: Object.fromEntries(Object.keys(ROLES).map((k) => [k, randomUUID()])) as Record<Member, string>,
});
type World = ReturnType<typeof ids>;

/** The same world in both databases (as the superuser; triggers run as for any server write). */
function seed(db: string, w: World): void {
  const u = w.uid;
  const people = [
    ...Object.entries(ROLES).map(([k, role]) => ({ uid: u[k as Member], k, role, org: w.org, status: k === "gone" ? "suspended" : "active" })),
    { uid: w.outsider, k: "outsider", role: "Admin", org: w.other, status: "active" },
  ];
  const tag = w.org.slice(0, 8);
  admin(db, `
    INSERT INTO orgs (id, name, type) VALUES ('${w.org}', 'I-28 ${tag}', 'business'), ('${w.other}', 'I-28 other ${tag}', 'business');
    ${people.map((p) => `
    INSERT INTO auth.users (id, email, aud, role) VALUES ('${p.uid}', '${p.k}-${tag}@i28.test', 'authenticated', 'authenticated');
    INSERT INTO users (id, email, display_name, default_org_id) VALUES ('${p.uid}', '${p.k}-${tag}@i28.test', '${p.k}', '${p.org}');
    INSERT INTO org_members (org_id, uid, email, role, roles, status) VALUES ('${p.org}', '${p.uid}', '${p.k}-${tag}@i28.test', '${p.role}', ARRAY[]::text[], '${p.status}');`).join("")}
    -- holds.release is STORED as "*" (the pre-20261239 default): drafting-flow
    -- HAND-2's 20261239 later moves the shipped default to Admin / DocCtrl
    -- (plus a hold's own opener), which the after-replay would otherwise
    -- read as a 20261224 change; dfP11HoldsRelease.test.ts pins that default.
    INSERT INTO org_configurations (org_id, key, data) VALUES ('${w.org}', 'capability_policy',
      '{"caps": {"transmittal.issue": ["Admin", "DocCtrl"], "quality.sign_off": ["Engineer-1"], "holds.release": ["*"]}}'::jsonb);
    INSERT INTO teams (id, org_id, name, supervisor_user_id) VALUES ('${w.team}', '${w.org}', 'Team ${tag}', '${u.supervisor}');
    INSERT INTO libraries (id, org_id, name, type, owner_user_id, acl_index) VALUES ('${w.lib1}', '${w.org}', 'L1', 'documents', '${u.libowner}',
      '{"allow":{"users":{"publish":["${u.publisher}"]}},"deny":{"users":{"upload":["${u.denied}"],"write":["${u.denied}"]}}}'::jsonb);
    INSERT INTO libraries (id, org_id, name, type, owner_team_id) VALUES ('${w.lib2}', '${w.org}', 'L2', 'documents', '${w.team}');
    INSERT INTO collections (id, org_id, library_id, name, owner_user_id) VALUES ('${w.folder}', '${w.org}', '${w.lib1}', 'C1', '${u.folderowner}');
    INSERT INTO documents (id, org_id, library_id, collection_id, title, status, owner_user_id, visibility, acl_index) VALUES
      ('${w.d1}', '${w.org}', '${w.lib1}', NULL, 'D1 owned', 'Draft', '${u.owner}', 'restricted', '{}'::jsonb),
      ('${w.d2}', '${w.org}', '${w.lib1}', '${w.folder}', 'D2 suspended owner', 'Draft', '${u.gone}', 'restricted', '{}'::jsonb),
      ('${w.d3}', '${w.org}', '${w.lib2}', NULL, 'D3 team library', 'Draft', NULL, 'restricted', '{}'::jsonb),
      ('${w.d4}', '${w.org}', '${w.lib1}', NULL, 'D4 checked out', 'Draft', '${u.owner}', 'normal', NULL),
      ('${w.d5}', '${w.org}', '${w.lib1}', NULL, 'D5 write deny', 'Draft', '${u.owner}', 'normal', '{"deny":{"users":{"write":["${u.denied}"]}}}'::jsonb),
      ('${w.d6}', '${w.org}', '${w.lib1}', NULL, 'D6 issued', 'Draft', '${u.owner}', 'normal', NULL);
    UPDATE documents SET review_control = '{"mode":"require","ownerMustApprove":true}'::jsonb WHERE id = '${w.d2}';
    INSERT INTO document_versions (id, org_id, record_id, revision_label, file_url, created_by) VALUES
      ('${w.v1}', '${w.org}', '${w.d1}', 'A', 'i28/${tag}/d1a.pdf', '${u.owner}'),
      ('${w.v2}', '${w.org}', '${w.d2}', 'A', 'i28/${tag}/d2a.pdf', '${u.publisher}'),
      ('${w.v6}', '${w.org}', '${w.d6}', 'A', 'i28/${tag}/d6a.pdf', '${u.owner}');
    UPDATE documents SET current_version_id = '${w.v6}', status = 'Issued', rev = 'A' WHERE id = '${w.d6}';
    INSERT INTO document_acknowledgments (id, org_id, document_id, assignee_user_id) VALUES
      ('${w.ack1}', '${w.org}', '${w.d1}', '${u.viewer}'), ('${w.ack2}', '${w.org}', '${w.d6}', '${u.viewer}');
    -- an open roster on D6's issued revision: the Manager's primary row and the Engineer's standby alternate
    INSERT INTO document_review_signoffs (id, org_id, document_id, document_version_id, reviewer_user_id, slot, activated) VALUES
      ('${w.so1}', '${w.org}', '${w.d6}', '${w.v6}', '${u.manager}', 'primary', true),
      ('${w.so2}', '${w.org}', '${w.d6}', '${w.v6}', '${u.denied}', 'alternate', false);
    INSERT INTO document_holds (id, org_id, document_id, reason, notes, opened_by) VALUES ('${w.hold}', '${w.org}', '${w.d4}', 'Other', 'harness', '${u.docctrl}');
    INSERT INTO revision_branches (id, org_id, document_id, branch_version_id, reason, created_by) VALUES ('${w.branch}', '${w.org}', '${w.d1}', '${w.v1}', 'branch', '${u.owner}');
    INSERT INTO audit_logs (org_id, action, resource_type, resource_id) VALUES
      ('${w.org}', 'MEMBER_ROLE_CHANGED', 'member', 'i28-${tag}'), ('${w.org}', 'DOC_VIEWED', 'document', 'i28-${tag}');
    INSERT INTO projects (id, org_id, name, owner_user_id, created_by) VALUES ('${w.project}', '${w.org}', 'P1', '${u.manager}', '${u.manager}');
    INSERT INTO project_members (project_id, user_id) VALUES ('${w.project}', '${u.viewer}');
    INSERT INTO project_documents (id, org_id, project_id, document_id) VALUES ('${w.pdoc}', '${w.org}', '${w.project}', '${w.d4}');
    UPDATE documents SET checked_out_by = '${u.viewer}', checked_out_at = now() WHERE id = '${w.d4}';
    -- a DRAFT transmittal the Viewer made, ready to issue: a recipient, and one item naming the
    -- issued document with the issuer's yes to an unchecked stamp (TRX-17)
    INSERT INTO transmittals (id, org_id, seq, number, status, created_by, recipient_name, subject, items) VALUES
      ('${w.draft}', '${w.org}', 2, 'TR-${tag}-2', 'draft', '${u.viewer}', 'Acme', 'Issue', '[{"documentId":"${w.d6}","number":"D6","stampAccepted":true}]'::jsonb);
    INSERT INTO checkout_sessions (id, org_id, document_id, library_id, user_id, status) VALUES ('${w.session}', '${w.org}', '${w.d4}', '${w.lib1}', '${u.viewer}', 'active');
    -- an ISSUED transmittal created by the Viewer. A service-role INSERT born
    -- issued is a restore and lands voided (DEC-45), so it is seeded with the
    -- triggers off; every statement under test runs with them on.
    SET session_replication_role = replica;
    INSERT INTO transmittals (id, org_id, seq, number, status, created_by, items, issued_at, portal_token) VALUES
      ('${w.tr}', '${w.org}', 1, 'TR-${tag}', 'issued', '${u.viewer}', '[{"documentId":"${w.d6}","number":"D6"}]'::jsonb, now(), md5('${w.tr}'));
    RESET session_replication_role;`);
}

/** One statement as `who`, as PostgREST runs it, in a transaction that is rolled back.
 *  `after` runs as the superuser before the rollback (reads what the statement wrote). */
function probe(db: string, w: World, who: Who, stmt: string, after?: string): string {
  const { conn } = mosDb();
  const me = who === "anon" || who === "service" ? NIL : who === "outsider" ? w.outsider : w.uid[who];
  const claims = who === "anon" ? { role: "anon" } : who === "service" ? { role: "service_role" } : { role: "authenticated", sub: me };
  const role = who === "anon" ? "anon" : who === "service" ? "service_role" : "authenticated";
  const sql = [
    "BEGIN;",
    `SET LOCAL ROLE ${role};`,
    `SELECT set_config('request.jwt.claims', ${dollarQuote(JSON.stringify(claims))}, true);`,
    `SELECT harness.try_sql(${dollarQuote(stmt.split("@ME").join(me))});`,
    ...(after ? ["RESET ROLE;", after] : []),
    "ROLLBACK;",
  ].join("\n");
  const r = runPsql(conn!, db, conn!.superuser, { sql });
  if (!r.ok) throw new Error(`probe failed on ${db} as ${who}: ${r.error ?? r.stderr}`);
  return r.stdout.split("\n").filter((l) => l.length > 0).slice(1).join(" / ");
}

interface Case { name: string; stmt: (w: World) => string; after?: (w: World) => string; expect: Partial<Record<Who, string>> }

// Every statement a policy (or a guard) that calls one of the helpers judges.
// `expect` pins the outcome the policies give on BOTH sides (an outcome's
// prefix), so the comparison is never vacuous: each case has readers allowed
// and readers refused.
const CASES: readonly Case[] = [
  { name: "documents_acl_select → node_visible → user_is_effective_owner (restricted rows; owner at every rung, a suspended owner skipped)",
    stmt: (w) => `SELECT 1 FROM documents WHERE id IN ('${w.d1}', '${w.d2}', '${w.d3}')`,
    expect: { anon: "ok:0", outsider: "ok:0", viewer: "ok:0", owner: "ok:1", folderowner: "ok:1", supervisor: "ok:1", libowner: "ok:0", gone: "ok:0", docctrl: "ok:3", service: "ok:3" } },
  { name: "documents_deny_upload_guard → acl_index_denies (INSERT into a library that denies one person upload)",
    stmt: (w) => `INSERT INTO documents (org_id, library_id, title, status, owner_user_id) VALUES ('${w.org}', '${w.lib1}', 'new', 'Draft', '@ME')`,
    expect: { anon: "err:42501", outsider: "err:42501", denied: "err:42501", viewer: "ok:1", publisher: "ok:1", docctrl: "ok:1", service: "ok:1" } },
  { name: "documents_deny_write_guard → acl_index_denies (UPDATE of a document whose index denies one person write)",
    stmt: (w) => `UPDATE documents SET title = 'edited' WHERE id = '${w.d5}'`,
    expect: { anon: "ok:0", outsider: "ok:0", denied: "ok:0", viewer: "ok:1", owner: "ok:1", docctrl: "ok:1" } },
  { name: "doc_ack_update → user_is_effective_owner / user_can_publish_on_library (a restricted document's ack)",
    stmt: (w) => `UPDATE document_acknowledgments SET assignee_name = 'x' WHERE id = '${w.ack1}'`,
    expect: { anon: "ok:0", outsider: "ok:0", viewer: "ok:1", owner: "ok:1", publisher: "ok:0", libowner: "ok:0", docctrl: "ok:1" } },
  { name: "doc_ack_update → user_can_publish_on_library (an issued document's ack: the library publisher)",
    stmt: (w) => `UPDATE document_acknowledgments SET assignee_name = 'x' WHERE id = '${w.ack2}'`,
    expect: { publisher: "ok:1", owner: "ok:1", libowner: "ok:0", manager: "ok:0", denied: "ok:0" } },
  { name: "doc_disposition_events_insert_authority (RESTRICTIVE) → user_is_effective_owner / user_can_publish_on_library",
    stmt: (w) => `INSERT INTO document_disposition_events (org_id, document_id, action, performed_by) VALUES ('${w.org}', '${w.d6}', 'note', '@ME')`,
    expect: { anon: "err:42501", viewer: "err:42501", owner: "ok:1", publisher: "ok:1", manager: "err:42501", docctrl: "ok:1", service: "ok:1" } },
  { name: "doc_review_signoff_insert → the owner and publisher limbs; review_signoff_owner_stamp stamps the folder owner (a suspended document owner skipped)",
    stmt: (w) => `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id) VALUES ('${w.org}', '${w.d2}', '${w.v2}', '${w.uid.viewer}')`,
    after: (w) => `SELECT 'slot=' || COALESCE(opened_owner_slot, '-') FROM document_review_signoffs WHERE document_version_id = '${w.v2}';`,
    expect: { anon: "err:42501", viewer: "err:42501", owner: "err:42501", publisher: "err:42501", folderowner: "ok:1 / slot=owner:", docctrl: "ok:1 / slot=owner:" } },
  { name: "doc_review_signoff_insert on an issued document (the publisher limb)",
    stmt: (w) => `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id) VALUES ('${w.org}', '${w.d6}', '${w.v6}', '${w.uid.viewer}')`,
    expect: { owner: "ok:1", publisher: "ok:1", viewer: "err:42501", libowner: "err:42501", docctrl: "ok:1" } },
  { name: "doc_review_signoff_update → the reviewer, controller, owner and publisher limbs (a roster row's role note)",
    stmt: (w) => `UPDATE document_review_signoffs SET reviewer_role = 'note' WHERE id = '${w.so1}'`,
    expect: { anon: "ok:0", outsider: "ok:0", viewer: "ok:0", libowner: "ok:0", folderowner: "ok:0", gone: "ok:0", manager: "ok:1", owner: "ok:1", publisher: "ok:1", docctrl: "ok:1", service: "ok:1" } },
  { name: "doc_review_signoff_update; enforce_review_signoff_guard RG-4 → user_is_effective_owner / user_can_publish_on_library about the caller (activate an alternate)",
    stmt: (w) => `UPDATE document_review_signoffs SET activated = true WHERE id = '${w.so2}'`,
    after: (w) => `SELECT 'activated=' || activated FROM document_review_signoffs WHERE id = '${w.so2}';`,
    expect: { anon: "ok:0 / activated=false", viewer: "ok:0 / activated=false", denied: "err:23514", owner: "ok:1 / activated=true", publisher: "ok:1 / activated=true", docctrl: "ok:1 / activated=true", service: "ok:1 / activated=true" } },
  { name: "revision_branches_org_update → user_is_effective_owner",
    stmt: (w) => `UPDATE revision_branches SET resolved_at = now(), resolution = 'withdrawn', resolution_note = 'n', resolved_by = '@ME' WHERE id = '${w.branch}'`,
    expect: { anon: "ok:0", viewer: "ok:0", owner: "ok:1", folderowner: "ok:0", docctrl: "ok:1" } },
  { name: "document_shares_insert → user_can_publish_on_library (with node_visible, document_share_refusal, user_download_denied)",
    stmt: (w) => `INSERT INTO document_shares (token, org_id, document_id, created_by, expires_at) VALUES (md5(random()::text), '${w.org}', '${w.d6}', '@ME', now() + interval '30 days')`,
    expect: { anon: "err:42501", outsider: "err:42501", owner: "err:42501", publisher: "ok:1", docctrl: "ok:1", service: "ok:1" } },
  { name: "audit_logs_admin_trail (RESTRICTIVE) → org_capability_allows admin.audit_view",
    stmt: (w) => `SELECT 1 FROM audit_logs WHERE org_id = '${w.org}' AND resource_id = 'i28-${w.org.slice(0, 8)}'`,
    expect: { anon: "ok:0", outsider: "ok:0", viewer: "ok:1", manager: "ok:2", docctrl: "ok:2", service: "ok:2" } },
  { name: "document_holds_insert → org_capability_allows holds.open",
    stmt: (w) => `INSERT INTO document_holds (org_id, document_id, reason, notes, opened_by) VALUES ('${w.org}', '${w.d1}', 'Other', 'why', '@ME')`,
    expect: { anon: "err:42501", outsider: "err:42501", viewer: "err:42501", owner: "ok:1", docctrl: "ok:1" } },
  { name: "document_holds_update → org_capability_allows holds.release",
    stmt: (w) => `UPDATE document_holds SET released_at = now(), released_by = '@ME', released_reason = 'done' WHERE id = '${w.hold}'`,
    expect: { anon: "ok:0", outsider: "ok:0", gone: "ok:0", viewer: "ok:1", docctrl: "ok:1" } },
  { name: "transmittals_update → org_capability_allows; transmittals_guard TRX-1 → caller_capability_allows (void an issued transmittal)",
    stmt: (w) => `UPDATE transmittals SET status = 'voided' WHERE id = '${w.tr}'`,
    expect: { anon: "ok:0", outsider: "ok:0", viewer: "err:42501", manager: "ok:0", docctrl: "ok:1", admin: "ok:1", service: "ok:1" } },
  { name: "transmittals_update; transmittals_guard TRX-1 → caller_capability_allows, then the issue gate (issue a draft)",
    stmt: (w) => `UPDATE transmittals SET status = 'issued' WHERE id = '${w.draft}'`,
    after: (w) => `SELECT 'status=' || status FROM transmittals WHERE id = '${w.draft}';`,
    expect: { anon: "ok:0 / status=draft", outsider: "ok:0 / status=draft", viewer: "err:42501", manager: "ok:0 / status=draft", docctrl: "ok:1 / status=issued", admin: "ok:1 / status=issued", service: "ok:1 / status=issued" } },
  { name: "transmittals_guard TRX-1 (revoke the portal link)",
    stmt: (w) => `UPDATE transmittals SET portal_revoked_at = now() WHERE id = '${w.tr}'`,
    expect: { viewer: "err:42501", docctrl: "ok:1", admin: "ok:1", service: "ok:1" } },
  { name: "enforce_document_lock_guard → org_capability_allows checkout.force_release",
    stmt: (w) => `UPDATE documents SET checked_out_by = NULL, checked_out_at = NULL WHERE id = '${w.d4}'`,
    expect: { anon: "ok:0", viewer: "ok:1", owner: "err:23514", manager: "err:23514", docctrl: "ok:1", service: "ok:1" } },
  { name: "enforce_checkout_session_guard (release) → org_capability_allows checkout.force_release",
    stmt: (w) => `UPDATE checkout_sessions SET status = 'released', released_at = now(), released_by = '@ME', released_reason = 'r' WHERE id = '${w.session}'`,
    expect: { anon: "ok:0", viewer: "ok:1", owner: "err:23514", docctrl: "ok:1" } },
  { name: "enforce_checkout_session_guard (delete) → org_capability_allows checkout.force_release",
    stmt: (w) => `DELETE FROM checkout_sessions WHERE id = '${w.session}'`,
    expect: { viewer: "ok:1", manager: "err:23514", docctrl: "ok:1" } },
  { name: "project_members_select → project_org",
    stmt: (w) => `SELECT 1 FROM project_members WHERE project_id = '${w.project}'`,
    expect: { anon: "ok:0", outsider: "ok:0", gone: "ok:0", viewer: "ok:1", manager: "ok:1", service: "ok:1" } },
  { name: "project_members_write → project_org",
    stmt: (w) => `INSERT INTO project_members (project_id, user_id) VALUES ('${w.project}', '${w.uid.publisher}')`,
    expect: { anon: "err:42501", outsider: "err:42501", viewer: "err:42501", manager: "ok:1", docctrl: "ok:1" } },
  { name: "change_orders_insert → project_org",
    stmt: (w) => `INSERT INTO change_orders (org_id, project_id, co_number, title, reason_code, created_by) VALUES ('${w.org}', '${w.project}', 'CO-1', 't', 'other', '@ME')`,
    expect: { anon: "err:42501", outsider: "err:42501", viewer: "err:42501", manager: "ok:1", docctrl: "ok:1" } },
  { name: "project_activity_insert → project_org",
    stmt: (w) => `INSERT INTO project_activity (project_id, org_id, user_id, type, body) VALUES ('${w.project}', '${w.org}', '@ME', 'note', 'b')`,
    expect: { anon: "err:42501", outsider: "err:42501", gone: "err:42501", viewer: "ok:1", manager: "ok:1" } },
  { name: "project_documents_insert → project_org",
    stmt: (w) => `INSERT INTO project_documents (org_id, project_id, document_id) VALUES ('${w.org}', '${w.project}', '${w.d1}')`,
    expect: { anon: "err:42501", outsider: "err:42501", owner: "err:42501", viewer: "ok:1", manager: "ok:1" } },
  { name: "project_documents_update → project_org",
    stmt: (w) => `UPDATE project_documents SET last_seen_at = now() WHERE id = '${w.pdoc}'`,
    expect: { anon: "ok:0", owner: "ok:0", viewer: "ok:1", manager: "ok:1" } },
  { name: "quality_signoff_status → quality_signer_eligible / quality_other_signers → org_capability_allows_for about OTHER signers (definers)",
    // one row per other eligible signer: the two controllers, the project owner and the
    // Engineer-1 holder of quality.sign_off (eligible ONLY through org_capability_allows_for)
    stmt: (w) => `SELECT generate_series(1, (SELECT (quality_signoff_status('${w.project}')->>'otherSigners')::int))`,
    expect: { anon: "err:42501", outsider: "ok:0", viewer: "ok:4", denied: "ok:3", manager: "ok:3", docctrl: "ok:3" } },
  { name: "the app's own calls (lib/ownership.ts, lib/revisions.ts, lib/documentShares.ts): a signed-in caller asks about itself, and every answer is pinned per caller",
    // The row count is a bitmask of the five answers, so the before/after
    // comparison compares the answers themselves (not that a call returned):
    //   1  user_is_effective_owner(D1's owner, no folder, L1)   — the document owner
    //   2  user_is_effective_owner(suspended owner, C1, L1)      — the folder owner (the suspended owner skipped)
    //   4  user_is_effective_owner(no owner, no folder, L2)      — the owning team's supervisor (lib/revisions.ts)
    //   8  user_can_publish_on_library(L1)                       — the granted publisher, and the controllers (lib/documentShares.ts)
    //   16 org_capability_allows(checkout.force_release)         — the controllers' shipped default
    // A caller with no uid (the anon key, the service role) has nothing to ask about itself: 0 rows.
    // The mask is a scalar subquery: the planner's row estimate for generate_series
    // evaluates plain STABLE arguments while planning, before the signed-in filter.
    stmt: (w) => `SELECT generate_series(1, (SELECT user_is_effective_owner('${w.uid.owner}', NULL, '${w.lib1}', '@ME')::int
                    + 2 * user_is_effective_owner('${w.uid.gone}', '${w.folder}', '${w.lib1}', '@ME')::int
                    + 4 * user_is_effective_owner(NULL, NULL, '${w.lib2}', '@ME')::int
                    + 8 * user_can_publish_on_library('${w.lib1}', '@ME', '${w.org}')::int
                    + 16 * org_capability_allows('${w.org}', 'checkout.force_release', '@ME')::int))
                    FROM (SELECT 1 WHERE '@ME' <> '${NIL}') signed_in`,
    expect: { anon: "ok:0", outsider: "ok:0", viewer: "ok:0", denied: "ok:0", owner: "ok:1", folderowner: "ok:2", supervisor: "ok:4", publisher: "ok:8",
              libowner: "ok:0", gone: "ok:0", manager: "ok:0", docctrl: "ok:24", admin: "ok:24", service: "ok:0" } },
];

/** An outcome with the world's own ids and tag written as names, so two worlds compare. */
function normalise(text: string, w: World): string {
  let out = text;
  for (const [k, v] of Object.entries(w.uid)) out = out.split(v).join(`<${k}>`);
  for (const [k, v] of Object.entries(w)) if (typeof v === "string") out = out.split(v).join(`<${k}>`);
  return out.split(w.org.slice(0, 8)).join("<tag>");
}

function compare(before: string, after: string, w0: World, w1: World, c: Case): { mismatches: string[]; outcomes: Record<string, string> } {
  const mismatches: string[] = [];
  const outcomes: Record<string, string> = {};
  for (const who of WHO) {
    const b = normalise(probe(before, w0, who, c.stmt(w0), c.after?.(w0)), w0);
    const a = normalise(probe(after, w1, who, c.stmt(w1), c.after?.(w1)), w1);
    outcomes[who] = a;
    if (a !== b) mismatches.push(`${who}: before ${b} | after ${a}`);
  }
  return { mismatches, outcomes };
}

describe.skipIf(skip !== null)("INTK-19 (20261224): every policy and invoker caller answers exactly as before, per role", () => {
  const before = () => mosDb().report!.checkpoints["20261224"];
  const after = REPLAY_DB;
  let w0: World;
  let w1: World;

  beforeAll(() => {
    w0 = ids();
    w1 = ids();
    seed(before(), w0);
    seed(after, w1);
  });

  it("the checkpoint exists: the replay snapshotted the sequence just before 20261224, and that snapshot has not had it", () => {
    expect(before()).toBe("mos_before_20261224");
    expect(admin(before(), `SELECT to_regprocedure('public.caller_capability_allows(uuid,text,jsonb)') IS NULL`)).toBe("t");
    expect(admin(after, `SELECT to_regprocedure('public.caller_capability_allows(uuid,text,jsonb)') IS NOT NULL`)).toBe("t");
  });

  for (const c of CASES) {
    it(c.name, () => {
      const { mismatches, outcomes } = compare(before(), after, w0, w1, c);
      expect(mismatches).toEqual([]);
      // an outcome's prefix; a bare row count ("ok:2") is the whole outcome, so ok:2 never passes for ok:24
      for (const [who, want] of Object.entries(c.expect)) expect(outcomes[who], `${who} (both sides)`).toMatch(new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}${/^ok:\d+$/.test(want) ? "(?!\\d)" : ""}`));
    });
  }

  it("the doors: a client role asking a bound helper about ANOTHER person was answered before and is refused 42501 after; the service role is answered both times", () => {
    const asks = (w: World) => ({
      publish: `SELECT 1 WHERE user_can_publish_on_library('${w.lib1}', '${w.uid.publisher}', '${w.org}')`,
      owner: `SELECT 1 WHERE user_is_effective_owner('${w.uid.owner}', NULL, '${w.lib1}', '${w.uid.owner}')`,
      capability: `SELECT 1 WHERE org_capability_allows('${w.org}', 'checkout.force_release', '${w.uid.docctrl}')`,
      deny: `SELECT 1 WHERE acl_index_denies('{"deny":{"users":{"upload":["${w.uid.denied}"]}}}'::jsonb, '${w.org}', '${w.uid.denied}', 'upload')`,
    });
    for (const who of ["anon", "outsider", "viewer", "manager", "docctrl"] as const) {
      for (const [k, q] of Object.entries(asks(w0))) expect(probe(before(), w0, who, q), `${who} ${k} before`).toBe("ok:1");
      for (const [k, q] of Object.entries(asks(w1))) {
        if (who === "docctrl" && k === "capability") continue; // asking about itself
        expect(probe(after, w1, who, q), `${who} ${k} after`).toMatch(/^err:42501:\w+ answers a client only about the signed-in caller \(INTK-19\)\.$/);
      }
    }
    for (const [k, q] of Object.entries(asks(w1))) expect(probe(after, w1, "service", q), `service ${k}`).toBe("ok:1");
  });

  it("org_capability_allows_for: any signed-in account could ask it about anyone before; after, only the service role may call it", () => {
    const q = (w: World) => `SELECT 1 WHERE org_capability_allows_for('${w.org}', 'transmittal.issue', '${w.uid.docctrl}', '{}'::jsonb)`;
    for (const who of ["outsider", "viewer", "docctrl"] as const) {
      expect(probe(before(), w0, who, q(w0)), who).toBe("ok:1");
      expect(probe(after, w1, who, q(w1)), who).toMatch(/^err:42501:permission denied for function org_capability_allows_for/);
    }
    expect(probe(before(), w0, "anon", q(w0))).toMatch(/^err:42501/);
    expect(probe(after, w1, "anon", q(w1))).toMatch(/^err:42501/);
    expect(probe(after, w1, "service", q(w1))).toBe("ok:1");
    // the caller-bound form answers a member about itself, and anon not at all
    const mine = (w: World) => `SELECT 1 WHERE caller_capability_allows('${w.org}', 'transmittal.issue', '{}'::jsonb)`;
    expect(probe(after, w1, "docctrl", mine(w1))).toBe("ok:1");
    expect(probe(after, w1, "viewer", mine(w1))).toBe("ok:0");
    expect(probe(after, w1, "anon", mine(w1))).toMatch(/^err:42501:permission denied for function caller_capability_allows/);
  });

  it("project_org maps a project to its workspace for an active member of it only (and the service role); anon, another workspace and a suspended member get NULL", () => {
    const q = (w: World) => `SELECT 1 WHERE project_org('${w.project}') = '${w.org}'`;
    for (const who of ["anon", "outsider", "gone"] as const) {
      expect(probe(before(), w0, who, q(w0)), `${who} before`).toBe("ok:1");
      expect(probe(after, w1, who, q(w1)), `${who} after`).toBe("ok:0");
    }
    for (const who of ["viewer", "manager", "service"] as const) {
      expect(probe(before(), w0, who, q(w0)), `${who} before`).toBe("ok:1");
      expect(probe(after, w1, who, q(w1)), `${who} after`).toBe("ok:1");
    }
  });

  it("effective_owner_matches gives review_signoff_owner_stamp the same owner user_is_effective_owner names, at every rung, and no client role may call it", () => {
    const cases: [string | null, string | null, string, string][] = [
      [w1.uid.owner, null, w1.lib1, w1.uid.owner],
      [w1.uid.gone, w1.folder, w1.lib1, w1.uid.folderowner],
      [w1.uid.gone, null, w1.lib1, w1.uid.libowner],
      [null, null, w1.lib2, w1.uid.supervisor],
      [w1.uid.owner, null, w1.lib1, w1.uid.viewer],
    ];
    for (const [o, c, l, x] of cases) {
      const args = `${o ? `'${o}'` : "NULL"}, ${c ? `'${c}'` : "NULL"}, '${l}', '${x}'`;
      expect(admin(after, `SELECT effective_owner_matches(${args}) = user_is_effective_owner(${args})`), args).toBe("t");
    }
    for (const who of ["anon", "viewer", "service"] as const) {
      expect(probe(after, w1, who, `SELECT effective_owner_matches(NULL, NULL, '${w1.lib1}', '${w1.uid.libowner}')`), who).toMatch(/^err:42501:permission denied for function effective_owner_matches/);
    }
  });
});

describe.skipIf(skip !== null)("20261224 pasted as the SQL editor sends it (one message, as postgres), on a copy of the pre-paste snapshot", () => {
  const before = () => mosDb().report!.checkpoints["20261224"];
  interface Paste { ok: boolean; error: string | null; stderr: string; rows: { check: string; ok: string; n: string }[] }
  const paste = (db: string, sql = SQL): Paste => {
    const r = runPsql(mosDb().conn!, db, "postgres", { sql }, { client_min_messages: "notice" });
    const rows = r.stdout.split("\n").filter((l) => l.includes("|")).map((l) => {
      const parts = l.split("|");
      return { check: parts.slice(0, -2).join("|"), ok: parts.at(-2)!, n: parts.at(-1)! };
    });
    return { ok: r.ok, error: r.error, stderr: r.stderr, rows };
  };
  const withCopy = (name: string, fn: (db: string) => void) => {
    admin("postgres", `CREATE DATABASE ${name} TEMPLATE ${before()}`);
    try { fn(name); } finally { admin("postgres", `DROP DATABASE ${name}`); }
  };
  const n = (p: Paste, prefix: string) => p.rows.find((r) => r.check.startsWith(prefix))?.n;

  it("a first paste: 44 rows, the 13 probes true, the precondition rows 0; the replay's counts; anon and authenticated definer counts unchanged", () => {
    withCopy("mos_224_first", (db) => {
      const p = paste(db);
      expect(p.ok, p.error ?? "").toBe(true);
      expect(p.rows).toHaveLength(44);
      expect(p.rows.slice(0, 13).map((r) => r.ok)).toEqual(Array(13).fill("t"));
      expect(p.rows.slice(13).every((r) => r.ok === "")).toBe(true);
      expect(p.rows.filter((r) => r.check.startsWith("precondition (expect 0)")).map((r) => r.n)).toEqual(["0", "0", "0", "0"]);
      expect(n(p, "before: row-level-security policies whose USING or WITH CHECK names user_can_publish_on_library(")).toBe("5");
      expect(n(p, "before: row-level-security policies whose USING or WITH CHECK names user_is_effective_owner(")).toBe("5");
      expect(n(p, "before: row-level-security policies whose USING or WITH CHECK names org_capability_allows(")).toBe("4");
      expect(n(p, "before: row-level-security policies whose USING or WITH CHECK names acl_index_denies(")).toBe("2");
      expect(n(p, "before: row-level-security policies whose USING or WITH CHECK names project_org(")).toBe("6");
      expect(n(p, "before: SECURITY INVOKER functions whose body names org_capability_allows_for(")).toBe("1");
      expect(n(p, "before: roles of anon / authenticated / PUBLIC that may execute org_capability_allows_for")).toBe("1");
      expect(n(p, "after: SECURITY DEFINER functions in public the anon role may execute")).toBe(n(p, "before: SECURITY DEFINER functions in public the anon role may execute"));
      expect(n(p, "after: SECURITY DEFINER functions in public the authenticated role may execute")).toBe(n(p, "before: SECURITY DEFINER functions in public the authenticated role may execute"));
    });
  });

  it("a second paste is clean and changes nothing (the same functions, the same grants)", () => {
    withCopy("mos_224_repaste", (db) => {
      expect(paste(db).ok).toBe(true);
      const sig = () => admin(db, `SELECT string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || '=' || COALESCE(array_to_string(p.proacl, ','), ''), ';' ORDER BY p.oid::regprocedure::text) FROM pg_proc p
                                    WHERE p.proname IN ('user_can_publish_on_library', 'user_is_effective_owner', 'org_capability_allows', 'org_capability_allows_for', 'acl_index_denies', 'project_org', 'effective_owner_matches', 'caller_capability_allows', 'transmittals_guard', 'review_signoff_owner_stamp')`);
      const was = sig();
      const p = paste(db);
      expect(p.ok, p.error ?? "").toBe(true);
      expect(p.rows.slice(0, 13).map((r) => r.ok)).toEqual(Array(13).fill("t"));
      expect(n(p, "before: roles of anon / authenticated / PUBLIC that may execute org_capability_allows_for")).toBe("0");
      expect(sig()).toBe(was);
    });
  });

  it("20261217 pasted again after it is still clean (effective_owner_matches names no member_is_active)", () => {
    withCopy("mos_224_then_217", (db) => {
      expect(paste(db).ok).toBe(true);
      const r = runPsql(mosDb().conn!, db, "postgres", { sql: readFileSync(join(process.cwd(), "supabase", "migrations", "20261217_intel_roundG_definer_grants.sql"), "utf8") });
      expect(r.ok, r.error ?? "").toBe(true);
      expect(r.stdout).not.toMatch(/\|f\|/);
    });
  });

  // Each case puts ONE more client-reachable caller of org_capability_allows_for
  // on the snapshot: the paste then leaves its grants as they were, says so,
  // and probes false, while everything else in the file still applies.
  const blockers: Record<string, string> = {
    "a row-level-security policy": `CREATE POLICY mos_probe ON public.libraries AS RESTRICTIVE FOR SELECT USING (org_capability_allows_for(org_id, 'x', auth.uid(), '{}'::jsonb) OR true);`,
    "a SECURITY INVOKER function other than transmittals_guard": `CREATE FUNCTION public.mos_probe(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT org_capability_allows_for(p, 'x', auth.uid(), '{}'::jsonb) $$;`,
    "a view": `CREATE VIEW public.mos_probe AS SELECT org_capability_allows_for(o.id, 'x', auth.uid(), '{}'::jsonb) AS ok FROM public.orgs o;`,
    "a SECURITY DEFINER function owned by another non-superuser": `CREATE ROLE mos_probe_owner; GRANT CREATE ON SCHEMA public TO mos_probe_owner; CREATE FUNCTION public.mos_probe(p uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$ SELECT org_capability_allows_for(p, 'x', auth.uid(), '{}'::jsonb) $$; ALTER FUNCTION public.mos_probe(uuid) OWNER TO mos_probe_owner;`,
  };
  for (const [what, ddl] of Object.entries(blockers)) {
    it(`the live-database precondition: with ${what} naming org_capability_allows_for, its grants stay, a NOTICE says so, two probes answer false, and the rest applies`, () => {
      try {
        withCopy("mos_224_blocked", (db) => {
          admin(db, ddl);
          const acl = () => admin(db, `SELECT COALESCE(array_to_string(proacl, ','), '') FROM pg_proc WHERE oid = 'public.org_capability_allows_for(uuid,text,uuid,jsonb)'::regprocedure`);
          const was = acl();
          const p = paste(db);
          expect(p.ok, p.error ?? "").toBe(true);
          expect(p.stderr).toMatch(/NOTICE: {2}20261224 left org_capability_allows_for executable by signed-in accounts: 1 object\(s\)/);
          const probes = p.rows.slice(0, 13);
          expect(probes.filter((r) => r.ok !== "t").map((r) => r.check.split(":")[0])).toEqual(["precondition", "org_capability_allows_for"]);
          expect(acl()).toBe(was);
          expect(admin(db, `SELECT has_function_privilege('authenticated', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')`)).toBe("t");
          expect(admin(db, `SELECT to_regprocedure('public.caller_capability_allows(uuid,text,jsonb)') IS NOT NULL`)).toBe("t");
        });
      } finally {
        admin("postgres", `DROP ROLE IF EXISTS mos_probe_owner`);
      }
    });
  }

  // Each case takes away ONE file the paste needs: it raises, and changes
  // nothing. 20261137 and 20261136 each end by granting authenticated the
  // evaluator, so a paste before either would be undone silently by it.
  const missing: Record<string, string> = {
    "whose transmittals_guard is older than 20261199": `UPDATE pg_proc SET prosrc = replace(prosrc, 'TRX-17 (20261199)', 'TRX-17 (pending)') WHERE proname = 'transmittals_guard'`,
    "whose evaluator has no ai.manage_caps row (20261137 not pasted)": `UPDATE pg_proc SET prosrc = replace(prosrc, 'WHEN ''ai.manage_caps''', 'WHEN ''ai.pending''') WHERE proname = 'org_capability_allows_for'`,
    "without quality_signoff_granted_for (20261136 not pasted)": `ALTER FUNCTION public.quality_signoff_granted_for(uuid, uuid, uuid) RENAME TO quality_signoff_granted_for_pending`,
  };
  for (const [what, ddl] of Object.entries(missing)) {
    it(`the apply-order check: on a database ${what} the paste raises and changes nothing`, () => {
      withCopy("mos_224_order", (db) => {
        admin(db, ddl);
        const body = () => admin(db, `SELECT md5(prosrc) FROM pg_proc WHERE proname = 'user_can_publish_on_library'`);
        const was = body();
        const p = paste(db);
        expect(p.ok).toBe(false);
        expect(p.error).toMatch(/20261224 needs 20260913, 20261025, 20261042, 20261052, 20261059, 20261136, 20261137, 20261159 and 20261199 pasted first; nothing was changed\./);
        expect(body()).toBe(was);
        expect(admin(db, `SELECT to_regprocedure('public.caller_capability_allows(uuid,text,jsonb)') IS NULL`)).toBe("t");
        expect(admin(db, `SELECT has_function_privilege('authenticated', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')`)).toBe("t");
      });
    });
  }

  // The header's never-re-paste rule (INTK-19, review fix pass): an earlier
  // body of a caller this file moved does not revert the file, it BREAKS that
  // caller against the narrowed helper; pasting 20261224 again in the same
  // sitting mends it (after 20261133, 20261199 first: the apply-order check
  // refuses over 20261133's older guard). 20261137 only gives authenticated
  // the evaluator back.
  const pasteFile = (db: string, file: string) => {
    const r = runPsql(mosDb().conn!, db, "postgres", { sql: readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8") });
    expect(r.ok, `${file}: ${r.error ?? r.stderr}`).toBe(true);
  };
  const seeded = (name: string, fn: (db: string, w: World) => void) => withCopy(name, (db) => {
    const w = ids();
    seed(db, w);
    const p = paste(db);
    expect(p.ok, p.error ?? "").toBe(true);
    fn(db, w);
  });
  const trx = (w: World) => ({
    void: `UPDATE transmittals SET status = 'voided' WHERE id = '${w.tr}'`,
    issue: `UPDATE transmittals SET status = 'issued' WHERE id = '${w.draft}'`,
    revoke: `UPDATE transmittals SET portal_revoked_at = now() WHERE id = '${w.tr}'`,
  });

  const broken = (db: string, w: World) => {
    for (const who of ["docctrl", "admin"] as const) {
      for (const [k, q] of Object.entries(trx(w))) expect(probe(db, w, who, q), `${who} ${k}`).toMatch(/^err:42501:permission denied for function org_capability_allows_for/);
    }
    expect(probe(db, w, "service", trx(w).void)).toBe("ok:1");
  };
  const mended = (db: string, w: World) => {
    const again = paste(db);
    expect(again.ok, again.error ?? "").toBe(true);
    expect(again.rows.slice(0, 13).map((r) => r.ok)).toEqual(Array(13).fill("t"));
    for (const [k, q] of Object.entries(trx(w))) expect(probe(db, w, "docctrl", q), `${k} after 20261224 again`).toBe("ok:1");
  };

  it("never re-paste 20261199 after it: a transmit authority's issue, void and revoke then fail 42501 on org_capability_allows_for, until 20261224 is pasted again", () => {
    seeded("mos_224_then_199", (db, w) => {
      for (const [k, q] of Object.entries(trx(w))) expect(probe(db, w, "docctrl", q), `${k} before the re-paste`).toBe("ok:1");
      pasteFile(db, "20261199_dc_roundF_transmittal_issue_verdict.sql");
      broken(db, w);
      mended(db, w);
    });
  });

  it("never re-paste 20261133 after it: the same break; 20261224 alone is refused over 20261133's older guard, so 20261199 and then 20261224 mend it", () => {
    seeded("mos_224_then_133", (db, w) => {
      for (const [k, q] of Object.entries(trx(w))) expect(probe(db, w, "docctrl", q), `${k} before the re-paste`).toBe("ok:1");
      pasteFile(db, "20261133_dc_roundF_transmittal_rails.sql");
      broken(db, w);
      const refused = paste(db);
      expect(refused.ok).toBe(false);
      expect(refused.error).toMatch(/^.*20261224 needs .* pasted first; nothing was changed\./);
      broken(db, w);
      pasteFile(db, "20261199_dc_roundF_transmittal_issue_verdict.sql");
      broken(db, w);
      mended(db, w);
    });
  });

  it("never re-paste 20261159 after it: a signed-in roster opening that needs the owner then fails 42501 from user_is_effective_owner, until 20261224 is pasted again", () => {
    seeded("mos_224_then_159", (db, w) => {
      const open = `INSERT INTO document_review_signoffs (org_id, document_id, document_version_id, reviewer_user_id) VALUES ('${w.org}', '${w.d2}', '${w.v2}', '${w.uid.viewer}')`;
      const slot = `SELECT 'slot=' || COALESCE(opened_owner_slot, '-') FROM document_review_signoffs WHERE document_version_id = '${w.v2}';`;
      for (const who of ["docctrl", "folderowner"] as const) expect(normalise(probe(db, w, who, open, slot), w), who).toBe("ok:1 / slot=owner:<folderowner>");
      pasteFile(db, "20261159_dc_roundF_guard_owner_and_held_pointer.sql");
      for (const who of ["docctrl", "folderowner"] as const) {
        expect(probe(db, w, who, open), who).toMatch(/^err:42501:user_is_effective_owner answers a client only about the signed-in caller \(INTK-19\)\.$/);
      }
      // the service role is not a client role (and the stamp leaves a session with no uid alone)
      expect(probe(db, w, "service", open)).toBe("ok:1");
      const again = paste(db);
      expect(again.ok, again.error ?? "").toBe(true);
      for (const who of ["docctrl", "folderowner"] as const) expect(normalise(probe(db, w, who, open, slot), w), who).toBe("ok:1 / slot=owner:<folderowner>");
    });
  });

  it("re-pasting 20261137 after it only gives authenticated org_capability_allows_for back: the narrowing is undone, nothing breaks", () => {
    seeded("mos_224_then_137", (db, w) => {
      const signedIn = () => admin(db, `SELECT has_function_privilege('authenticated', 'public.org_capability_allows_for(uuid,text,uuid,jsonb)', 'EXECUTE')`);
      expect(signedIn()).toBe("f");
      pasteFile(db, "20261137_intel_roundG_ai_manage_caps.sql");
      expect(signedIn()).toBe("t");
      for (const [k, q] of Object.entries(trx(w))) expect(probe(db, w, "docctrl", q), k).toBe("ok:1");
      expect(probe(db, w, "viewer", trx(w).void)).toMatch(/^err:42501/);
      expect(paste(db).ok).toBe(true);
      expect(signedIn()).toBe("f");
    });
  });
});
