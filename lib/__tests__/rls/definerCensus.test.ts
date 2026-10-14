// INTK-14 done-when 2 (intelligence I-17): the census of every SECURITY
// DEFINER function's EXECUTE grants, read from the live catalog of the fresh
// replay and held to the reasoned decisions in definerDecisions.ts — and the
// before / after proof for 20261217, the one narrowing the census needed
// (DEC-30: the app works before and after the paste), with the membership
// answer it does NOT take away pinned as INTK-19's remainder.

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { BODY_CLAIM_DECISIONS, CALLABLE_DEFINERS, ORACLE_DECISIONS, PERSON_PARAM, RULING_4_RULED, TRIGGER_FUNCTIONS, type DefinerDecision } from "./definerDecisions";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();

interface Live {
  sig: string;
  trigger: boolean;
  anon: boolean;
  authenticated: boolean;
  service_role: boolean;
  pinned: boolean;
  /** The IN / INOUT / VARIADIC parameter names, in order. */
  inArgs: string[];
  /** pg_proc.prosrc: the body, verbatim. */
  src: string;
}

function liveDefiners(db: string): Live[] {
  const out = admin(db, `
    SELECT json_agg(json_build_object(
             'sig', p.oid::regprocedure::text,
             'trigger', p.prorettype = 'trigger'::regtype,
             'anon', has_function_privilege('anon', p.oid, 'EXECUTE'),
             'authenticated', has_function_privilege('authenticated', p.oid, 'EXECUTE'),
             'service_role', has_function_privilege('service_role', p.oid, 'EXECUTE'),
             'pinned', COALESCE(array_to_string(p.proconfig, ','), '') LIKE '%search_path=public%',
             'inArgs', COALESCE((SELECT json_agg(a.n ORDER BY a.i)
                                   FROM unnest(COALESCE(p.proargnames, '{}'::text[]),
                                               COALESCE(p.proargmodes::text[], array_fill('i'::text, ARRAY[COALESCE(cardinality(p.proargnames), 0)])))
                                        WITH ORDINALITY AS a(n, m, i)
                                  WHERE a.m IN ('i', 'b', 'v') AND COALESCE(a.n, '') <> ''), '[]'::json),
             'src', p.prosrc)
           ORDER BY p.oid::regprocedure::text)
      FROM pg_proc p
     WHERE p.prosecdef
       AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace, 'auth'::regnamespace, 'harness'::regnamespace)
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`);
  return out.trim() ? (JSON.parse(out) as Live[]) : [];
}

/** Whitespace runs collapsed: an evidence fragment is the body's text up to whitespace. */
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const callsFn = (text: string, name: string) => new RegExp(`\\b${name}\\s*\\(`).test(text);
const isOracle = (d: DefinerDecision) => ORACLE_DECISIONS.includes(d.decision);

describe.skipIf(skip !== null)("INTK-14: every SECURITY DEFINER function's EXECUTE grants carry a reasoned decision", () => {
  let live: Live[] = [];
  beforeAll(() => { live = liveDefiners(REPLAY_DB); });

  it("the census sees the whole population (every one in public)", () => {
    expect(live.length).toBeGreaterThan(150);
    expect(admin(REPLAY_DB, `SELECT count(*) FROM pg_proc p WHERE p.prosecdef AND p.pronamespace <> 'public'::regnamespace AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace)`)).toBe("0");
  });

  it("every trigger-returning definer is listed, and every listed one exists and returns trigger", () => {
    const liveTriggers = live.filter((l) => l.trigger).map((l) => l.sig).sort();
    const unlisted = liveTriggers.filter((s) => !TRIGGER_FUNCTIONS.includes(s));
    const stale = TRIGGER_FUNCTIONS.filter((s) => !liveTriggers.includes(s));
    expect(unlisted, "a new SECURITY DEFINER trigger function: add it to TRIGGER_FUNCTIONS").toEqual([]);
    expect(stale, "listed but no longer a definer trigger function on the replay: remove it").toEqual([]);
  });

  it("no trigger function can be called directly (0A000), so their EXECUTE grants are moot", () => {
    const callable = admin(REPLAY_DB, `
      DO $$
      DECLARE r record; n int := 0;
      BEGIN
        FOR r IN SELECT p.oid::regprocedure AS f FROM pg_proc p
                  WHERE p.prosecdef AND p.prorettype = 'trigger'::regtype AND p.pronamespace = 'public'::regnamespace LOOP
          BEGIN
            EXECUTE format('SELECT %s', r.f::text);
            n := n + 1;
          EXCEPTION WHEN feature_not_supported THEN NULL;
          END;
        END LOOP;
        PERFORM set_config('harness.callable_triggers', n::text, false);
      END $$;
      SELECT current_setting('harness.callable_triggers');`);
    expect(callable.split("\n").pop()).toBe("0");
  });

  it("every callable definer has a decision whose EXECUTE state is exactly the live one — a new one fails here until it has a reasoned row", () => {
    const rows = new Map(CALLABLE_DEFINERS.map((d) => [d.signature, d]));
    const problems: string[] = [];
    for (const l of live.filter((x) => !x.trigger)) {
      const d = rows.get(l.sig);
      if (!d) { problems.push(`${l.sig}: no decision row (anon=${l.anon}, authenticated=${l.authenticated}, service_role=${l.service_role})`); continue; }
      const want = d.execute;
      if (want.anon !== l.anon || want.authenticated !== l.authenticated || want.service_role !== l.service_role) {
        problems.push(`${l.sig}: decision ${d.decision} expects ${JSON.stringify(want)}, live is ${JSON.stringify({ anon: l.anon, authenticated: l.authenticated, service_role: l.service_role })}`);
      }
    }
    const liveSigs = new Set(live.filter((x) => !x.trigger).map((x) => x.sig));
    for (const d of CALLABLE_DEFINERS) if (!liveSigs.has(d.signature)) problems.push(`${d.signature}: decision row for a function the replay does not have`);
    expect(problems).toEqual([]);
  });

  it("every decision is reasoned, and every recorded narrowing has an owner", () => {
    for (const d of CALLABLE_DEFINERS) {
      expect(d.reason.length, d.signature).toBeGreaterThan(60);
      if (isOracle(d)) expect(d.owner, d.signature).toMatch(/INTK-19/);
      if (d.decision === "policy-helper" || d.decision === "policy-helper-oracle") expect(d.execute.anon, d.signature).toBe(true);
      if (d.decision === "signed-in-oracle") expect(d.execute, d.signature).toEqual({ anon: false, authenticated: true, service_role: true });
      if (d.decision === "service-only" || d.decision === "revoked-20261217") {
        expect(d.execute, d.signature).toEqual({ anon: false, authenticated: false, service_role: true });
      }
      // DEC-90 ruling 4, RULED by the integrator: no revoke, final, no owner
      if (d.decision === "anon-refused-by-body") {
        expect(d.execute, d.signature).toEqual({ anon: true, authenticated: true, service_role: true });
        expect(d.reason, d.signature).toContain(RULING_4_RULED);
        expect(d.owner, d.signature).toBeUndefined();
      }
      if (d.person?.binding === "caller-supplied-oracle") expect(d.owner, d.signature).toMatch(/INTK-19/);
    }
  });

  it("every decision about the body cites it: each evidence fragment is in the live function, and a caller-judging one reads the session", () => {
    const bySig = new Map(live.map((l) => [l.sig, l]));
    // A function "reads the session" when its body names auth.uid(), or calls
    // (by name) a function that does — to a fixed point over the definers.
    const readers = new Set(live.filter((l) => /auth\.uid\(\)/.test(l.src)).map((l) => l.sig.split("(")[0]));
    for (let grew = true; grew;) {
      grew = false;
      for (const l of live) {
        const name = l.sig.split("(")[0];
        if (!readers.has(name) && [...readers].some((r) => callsFn(l.src, r))) { readers.add(name); grew = true; }
      }
    }
    const problems: string[] = [];
    for (const d of CALLABLE_DEFINERS.filter((x) => BODY_CLAIM_DECISIONS.includes(x.decision))) {
      const l = bySig.get(d.signature);
      if (!l) continue; // reported by the two-way comparison above
      const body = squash(l.src);
      const fragments = [...(d.evidence ?? []), ...(d.person?.evidence ?? [])];
      if (!d.evidence?.length) problems.push(`${d.signature}: a ${d.decision} decision with no evidence from the body`);
      for (const f of fragments) if (!body.includes(squash(f))) problems.push(`${d.signature}: evidence not in the live body: ${f}`);
      if (!isOracle(d)) {
        const readsSession = (d.evidence ?? []).some((f) => /auth\.uid\(\)/.test(f) || [...readers].some((r) => callsFn(f, r)));
        if (!readsSession) problems.push(`${d.signature}: no evidence fragment reads the session (auth.uid() or a caller-scoped function)`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every client-callable definer that takes a person (PERSON_PARAM) binds it, with evidence, or is an oracle with an owner (INTK-19)", () => {
    const rows = new Map(CALLABLE_DEFINERS.map((d) => [d.signature, d]));
    const problems: string[] = [];
    let seen = 0;
    for (const l of live.filter((x) => !x.trigger && (x.anon || x.authenticated))) {
      const persons = l.inArgs.filter((a) => PERSON_PARAM.test(a));
      if (persons.length === 0) continue;
      seen++;
      const d = rows.get(l.sig);
      if (!d) continue; // reported by the two-way comparison above
      if (isOracle(d)) {
        if (!/INTK-19/.test(d.owner ?? "")) problems.push(`${l.sig}: an oracle with no owner`);
        continue;
      }
      if (!d.person) { problems.push(`${l.sig}: takes ${persons.join(", ")} but its row neither binds it (person) nor records an oracle`); continue; }
      if (!persons.includes(d.person.param)) problems.push(`${l.sig}: person.param ${d.person.param} is not one of its person parameters (${persons.join(", ")})`);
      const body = squash(l.src);
      const named = d.person.evidence.filter((f) => new RegExp(`\\b${d.person!.param}\\b`).test(f));
      if (named.length === 0) problems.push(`${l.sig}: no person evidence names ${d.person.param}`);
      for (const f of d.person.evidence) if (!body.includes(squash(f))) problems.push(`${l.sig}: person evidence not in the live body: ${f}`);
      if ((d.person.binding === "is-the-caller" || d.person.binding === "judged-for-caller" || d.person.binding === "caller-supplied-oracle") && !named.some((f) => /auth\.uid\(\)/.test(f))) {
        problems.push(`${l.sig}: ${d.person.binding} needs a fragment that sets ${d.person.param} against auth.uid()`);
      }
      if (d.person.binding === "caller-supplied-oracle" && !/INTK-19/.test(d.owner ?? "")) problems.push(`${l.sig}: a caller-supplied-oracle binding with no owner`);
      // A function with several person parameters binds each, or is an oracle.
      if (persons.length > 1) problems.push(`${l.sig}: ${persons.length} person parameters; record an oracle or extend the row`);
    }
    expect(seen, "the replay has client-callable definers that take a person").toBeGreaterThan(5);
    expect(problems).toEqual([]);
  });

  it("an oracle decision is true to the body: it never reads auth.uid(), and its evidence names what it is told to judge", () => {
    const bySig = new Map(live.map((l) => [l.sig, l]));
    for (const d of CALLABLE_DEFINERS.filter(isOracle)) {
      const l = bySig.get(d.signature);
      expect(l, d.signature).toBeDefined();
      expect(/auth\.uid\(\)/.test(l!.src), `${d.signature} reads auth.uid(): re-reason the row (it may bind the person)`).toBe(false);
      const persons = l!.inArgs.filter((a) => PERSON_PARAM.test(a));
      const target = persons.length > 0 ? persons : l!.inArgs;
      expect((d.evidence ?? []).some((f) => target.some((a) => new RegExp(`\\b${a}\\b`).test(f))), d.signature).toBe(true);
    }
    // the authenticated-only oracle the review found (INTK-19)
    expect(CALLABLE_DEFINERS.find((d) => d.signature === "org_capability_allows_for(uuid,text,uuid,jsonb)")?.decision).toBe("signed-in-oracle");
  });

  it("a policy-helper decision is true to the catalog: some row-level-security policy really calls it", () => {
    const helpers = CALLABLE_DEFINERS.filter((d) => d.decision.startsWith("policy-helper")).map((d) => d.signature.split("(")[0]);
    for (const name of new Set(helpers)) {
      const n = admin(REPLAY_DB, `SELECT count(*) FROM pg_policy pol WHERE pg_get_expr(pol.polqual, pol.polrelid) ~ '\\m${name}\\(' OR COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ '\\m${name}\\('`);
      expect(Number(n), name).toBeGreaterThan(0);
    }
  });

  it("an own-scope-unused decision is true to the catalog: no policy and no other function names it", () => {
    const unused = CALLABLE_DEFINERS.filter((d) => d.decision === "own-scope-unused").map((d) => d.signature.split("(")[0]);
    expect(unused).toContain("is_org_assign_drafters"); // no longer a policy helper after 20261209
    for (const name of new Set(unused)) {
      const re = `'\\m${name}\\s*\\('`;
      const policies = admin(REPLAY_DB, `SELECT count(*) FROM pg_policy pol WHERE COALESCE(pg_get_expr(pol.polqual, pol.polrelid), '') ~ ${re} OR COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ ${re}`);
      const callers = admin(REPLAY_DB, `SELECT count(*) FROM pg_proc p WHERE p.proname <> '${name}' AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace) AND p.prosrc ~ ${re}`);
      expect({ name, policies: Number(policies), callers: Number(callers) }).toEqual({ name, policies: 0, callers: 0 });
    }
  });

  it("a role-only decision is true to the catalog: the intake_door role may execute it", () => {
    for (const d of CALLABLE_DEFINERS.filter((x) => x.decision === "role-only")) {
      expect(admin(REPLAY_DB, `SELECT has_function_privilege('intake_door', '${d.signature}'::regprocedure, 'EXECUTE')`), d.signature).toBe("t");
    }
  });

  it("DRLS-16: every SECURITY DEFINER function pins search_path = public", () => {
    expect(live.filter((l) => !l.pinned).map((l) => l.sig)).toEqual([]);
  });
});

describe.skipIf(skip !== null)("20261217: the app works before and after the paste (DEC-30)", () => {
  const before = () => mosDb().report!.checkpoints["20261217"];
  const after = REPLAY_DB;

  interface World { orgId: string; libId: string; docId: string; member: SeededMember }
  const worlds: Record<string, World> = {};

  function seed(db: string): World {
    const { orgId, m } = seedOrg(db, { admin: { role: "Admin" } });
    const libId = randomUUID();
    const docId = randomUUID();
    admin(db, `
      INSERT INTO libraries (id, org_id, name, type) VALUES ('${libId}', '${orgId}', 'Numbered', 'documents');
      INSERT INTO library_numbering (library_id, org_id, enabled, prefix, pad, next_number) VALUES ('${libId}', '${orgId}', true, 'DOC-', 4, 7);
      INSERT INTO documents (id, org_id, library_id, title, status, checked_out_by, checked_out_at, owner_user_id)
        VALUES ('${docId}', '${orgId}', '${libId}', 'Checked out', 'Draft', '${m.admin.uid}', now(), '${m.admin.uid}');`);
    return { orgId, libId, docId, member: m.admin };
  }

  beforeAll(() => {
    worlds.before = seed(before());
    worlds.after = seed(after);
  });

  it("the checkpoint exists: the replay snapshotted the sequence just before 20261217", () => {
    expect(before()).toBe("mos_before_20261217");
  });

  for (const phase of ["before", "after"] as const) {
    it(`${phase} the paste, a signed-in member's calls answer as today`, () => {
      const db = phase === "before" ? before() : after;
      const w = worlds[phase];
      const me = w.member.caller;
      expect(selectAs(db, me, `SELECT next_ticket_number('${w.orgId}', 2026)`)).toEqual(["1"]);
      expect(selectAs(db, me, `SELECT issue_document_number('${w.libId}')`)).toEqual(["DOC-0007"]);
      expect(selectAs(db, me, `SELECT user_is_effective_owner('${w.member.uid}', NULL, '${w.libId}', '${w.member.uid}')`)).toEqual(["t"]);
      const released = selectAs(db, me, `SELECT force_release_document('${w.docId}', 'harness')->>'documentId'`);
      expect(released).toEqual([w.docId]);
      expect(admin(db, `SELECT checked_out_by IS NULL FROM documents WHERE id = '${w.docId}'`)).toBe("t");
      // service-side callers keep member_is_active
      expect(selectAs(db, { role: "service_role" }, `SELECT member_is_active('${w.orgId}', '${w.member.uid}')`)).toEqual(["t"]);
    });
  }

  it("before the paste the anon key can call member_is_active (the direct door); after it, it is refused 42501", () => {
    const w0 = worlds.before;
    const w1 = worlds.after;
    const anon = { role: "anon" as const };
    expect(asCaller(before(), anon, `SELECT member_is_active('${w0.orgId}', '${w0.member.uid}')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(after, anon, `SELECT member_is_active('${w1.orgId}', '${w1.member.uid}')`)).toMatchObject({ ok: false, code: "42501" });
    // and a signed-in member can no longer call it directly either
    expect(asCaller(before(), w0.member.caller, `SELECT member_is_active('${w0.orgId}', '${w0.member.uid}')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(after, w1.member.caller, `SELECT member_is_active('${w1.orgId}', '${w1.member.uid}')`)).toMatchObject({ ok: false, code: "42501" });
  });

  it("DEC-90 ruling 4: the three functions the app calls as authenticated are untouched — the anon key reaches them, and each body refuses it, before and after", () => {
    const anon = { role: "anon" as const };
    for (const phase of ["before", "after"] as const) {
      const db = phase === "before" ? before() : after;
      const w = worlds[phase];
      // issue_document_number answers NULL (one row) and the counter does not move
      const nextBefore = admin(db, `SELECT next_number FROM library_numbering WHERE library_id = '${w.libId}'`);
      expect(selectAs(db, anon, `SELECT issue_document_number('${w.libId}') IS NULL`), phase).toEqual(["t"]);
      expect(admin(db, `SELECT next_number FROM library_numbering WHERE library_id = '${w.libId}'`), phase).toBe(nextBefore);
      // next_ticket_number and force_release_document raise in their bodies
      expect(asCaller(db, anon, `SELECT next_ticket_number('${w.orgId}', 2026)`), phase).toMatchObject({ ok: false, code: "P0001" });
      expect(asCaller(db, anon, `SELECT force_release_document('${w.docId}', 'x')`), phase).toMatchObject({ ok: false, code: "P0001" });
      for (const fn of ["next_ticket_number(uuid,integer)", "issue_document_number(uuid)", "force_release_document(uuid,text)"]) {
        expect(admin(db, `SELECT has_function_privilege('anon', '${fn}'::regprocedure, 'EXECUTE')`), `${phase}: ${fn}`).toBe("t");
      }
    }
    // the same ACL before and after the paste
    const acl = (db: string) => admin(db, `SELECT string_agg(p.oid::regprocedure::text || '=' || COALESCE(array_to_string(p.proacl, ','), ''), ';' ORDER BY 1) FROM pg_proc p WHERE p.proname IN ('next_ticket_number', 'issue_document_number', 'force_release_document')`);
    expect(acl(after)).toBe(acl(before()));
  });

  it("INTK-19's remainder, pinned: after the paste the same membership answer is still reachable — user_is_effective_owner to the anon key, node_visible's p_owner to a signed-in library owner", () => {
    const { orgId, m } = seedOrg(after, { active: { role: "Viewer" }, gone: { role: "Viewer" }, owner: { role: "Viewer" } });
    const libId = randomUUID();
    admin(after, `
      UPDATE org_members SET status = 'suspended' WHERE org_id = '${orgId}' AND uid = '${m.gone.uid}';
      INSERT INTO libraries (id, org_id, name, type, owner_user_id) VALUES ('${libId}', '${orgId}', 'Owned', 'documents', '${m.owner.uid}');`);
    const anon = { role: "anon" as const };
    const owns = (x: SeededMember) => `SELECT user_is_effective_owner('${x.uid}', NULL, '${libId}', '${x.uid}')`;
    // anon: true for the active member, false for the suspended one — member_is_active's answer
    expect(selectAs(after, anon, owns(m.active))).toEqual(["t"]);
    expect(selectAs(after, anon, owns(m.gone))).toEqual(["f"]);
    // with no library at all: "is X active in any org?"
    expect(selectAs(after, anon, `SELECT user_is_effective_owner('${m.active.uid}', NULL, NULL, '${m.active.uid}')`)).toEqual(["t"]);
    expect(selectAs(after, anon, `SELECT user_is_effective_owner('${m.gone.uid}', NULL, NULL, '${m.gone.uid}')`)).toEqual(["f"]);
    expect(asCaller(after, anon, `SELECT member_is_active('${orgId}', '${m.gone.uid}')`)).toMatchObject({ ok: false, code: "42501" });
    // a signed-in Viewer who owns the library: node_visible is true exactly when p_owner is NOT active
    const vis = (x: SeededMember) => `SELECT node_visible('restricted', '{}'::jsonb, '${orgId}', '${x.uid}', NULL, '${libId}')`;
    expect(selectAs(after, m.owner.caller, vis(m.active))).toEqual(["f"]);
    expect(selectAs(after, m.owner.caller, vis(m.gone))).toEqual(["t"]);
  });

  it("the header's ROLLBACK restores member_is_active's pre-paste ACL exactly", () => {
    const body = readFileSync(join(process.cwd(), "supabase", "migrations", "20261217_intel_roundG_definer_grants.sql"), "utf8");
    const rollback = /^--\s+(GRANT EXECUTE ON FUNCTION public\.member_is_active\(uuid, uuid\)[^\n]*;)$/m.exec(body)?.[1];
    expect(rollback).toBeDefined();
    const acl = `SELECT string_agg(e, ',' ORDER BY e) FROM (
                   SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END) || ':' || a.privilege_type || ':' || a.grantor::regrole::text AS e
                     FROM pg_proc p, aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
                    WHERE p.oid = 'public.member_is_active(uuid,uuid)'::regprocedure) x`;
    const was = admin(before(), acl);
    expect(was).toContain("PUBLIC:EXECUTE");
    expect(admin(after, acl)).not.toBe(was);
    // in a transaction that is rolled back, so the replay keeps the pasted state
    expect(admin(after, `BEGIN; ${rollback} ${acl}; ROLLBACK;`)).toBe(was);
    expect(admin(after, acl)).not.toContain("PUBLIC:EXECUTE");
  });

  it("a second paste of 20261217 is clean and changes nothing", () => {
    const sig = (db: string) => admin(db, `SELECT string_agg(p.oid::regprocedure::text || '=' || COALESCE(array_to_string(p.proacl, ','), ''), ';' ORDER BY 1) FROM pg_proc p WHERE p.proname IN ('member_is_active', 'next_ticket_number', 'issue_document_number', 'force_release_document')`);
    const was = sig(after);
    const body = readFileSync(join(process.cwd(), "supabase", "migrations", "20261217_intel_roundG_definer_grants.sql"), "utf8");
    const r = runPsql(mosDb().conn!, after, "postgres", { sql: body });
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.stdout).not.toMatch(/\|f\|/);
    expect(sig(after)).toBe(was);
  });

  it("the paste on the replay: the precondition holds (six counts, all 0), 3 probes true, 13 rows", () => {
    const db = "mos_217_repaste";
    admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${before()}`);
    try {
      const body = readFileSync(join(process.cwd(), "supabase", "migrations", "20261217_intel_roundG_definer_grants.sql"), "utf8");
      const r = runPsql(mosDb().conn!, db, "postgres", { sql: body });
      expect(r.ok, r.error ?? "").toBe(true);
      const rows = r.stdout.split("\n").map((l) => l.split("|"));
      expect(rows).toHaveLength(13);
      expect(rows.slice(0, 3).map((x) => x[1])).toEqual(["t", "t", "t"]);
      const pre = rows.filter((x) => x[0].startsWith("precondition (expect 0)"));
      expect(pre.map((x) => x[2])).toEqual(["0", "0", "0", "0", "0", "0"]);
      const n = (label: string) => rows.find((x) => x[0].startsWith(label))?.[2];
      expect(n("before: member_is_active(uuid, uuid) present")).toBe("1");
      expect(n("before: roles of anon / authenticated / PUBLIC")).toBe("3");
      expect(Number(n("before: SECURITY DEFINER functions in public the anon role may execute"))).toBe(Number(n("after: SECURITY DEFINER functions in public the anon role may execute")) + 1);
    } finally {
      admin("postgres", `DROP DATABASE ${db}`);
    }
  });

  // Each case puts ONE more caller of member_is_active on the pre-paste
  // snapshot; the paste must then change nothing, say so, and probe false.
  const blockers: Record<string, string> = {
    "a row-level-security policy": `CREATE POLICY mos_probe ON public.libraries AS RESTRICTIVE FOR SELECT USING (member_is_active(org_id, auth.uid()) OR true);`,
    "a SECURITY INVOKER function": `CREATE FUNCTION public.mos_probe(p uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT member_is_active(p, auth.uid()) $$;`,
    "a SECURITY INVOKER function with a SQL-standard body": `CREATE FUNCTION public.mos_probe(p uuid) RETURNS boolean LANGUAGE sql STABLE BEGIN ATOMIC SELECT member_is_active(p, auth.uid()); END;`,
    "a view": `CREATE VIEW public.mos_probe AS SELECT member_is_active(o.id, auth.uid()) AS active FROM public.orgs o;`,
    "a SECURITY DEFINER function other than user_is_effective_owner": `CREATE FUNCTION public.mos_probe(p uuid) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$ BEGIN RETURN member_is_active(p, auth.uid()); END $$;`,
    "a user_is_effective_owner owned by another non-superuser": `CREATE ROLE mos_probe_owner; GRANT CREATE ON SCHEMA public TO mos_probe_owner; ALTER FUNCTION public.user_is_effective_owner(uuid, uuid, uuid, uuid) OWNER TO mos_probe_owner;`,
    "a column default": `ALTER TABLE public.orgs ADD COLUMN mos_probe boolean DEFAULT member_is_active(NULL::uuid, NULL::uuid);`,
  };
  for (const [what, ddl] of Object.entries(blockers)) {
    it(`the live-database precondition: with ${what} naming member_is_active, the paste changes nothing, says so, and probes false`, () => {
      const db = "mos_217_blocked";
      admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${before()}`);
      try {
        const acl = `SELECT COALESCE(array_to_string(proacl, ','), '') FROM pg_proc WHERE oid = 'public.member_is_active(uuid,uuid)'::regprocedure`;
        admin(db, ddl);
        const was = admin(db, acl);
        const body = readFileSync(join(process.cwd(), "supabase", "migrations", "20261217_intel_roundG_definer_grants.sql"), "utf8");
        const r = runPsql(mosDb().conn!, db, "postgres", { sql: body }, { client_min_messages: "notice" });
        expect(r.ok, r.error ?? "").toBe(true);
        expect(r.stderr).toMatch(/NOTICE: {2}20261217 changed nothing: 1 object\(s\)/);
        const rows = r.stdout.split("\n").map((l) => l.split("|"));
        expect(rows.slice(0, 2).map((x) => x[1])).toEqual(["f", "f"]);
        expect(rows.filter((x) => x[0].startsWith("precondition (expect 0)")).map((x) => Number(x[2])).reduce((a, b) => a + b, 0)).toBe(1);
        expect(admin(db, acl)).toBe(was);
        expect(asCaller(db, { role: "anon" }, `SELECT member_is_active(NULL::uuid, NULL::uuid)`)).toEqual({ ok: true, rows: 1 });
      } finally {
        admin("postgres", `DROP DATABASE ${db}`);
        admin("postgres", `DROP ROLE IF EXISTS mos_probe_owner`);
      }
    });
  }
});
