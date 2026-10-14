// INTK-14 done-when 2 (intelligence I-17): the census of every SECURITY
// DEFINER function's EXECUTE grants, read from the live catalog of the fresh
// replay and held to the reasoned decisions in definerDecisions.ts — and the
// before / after proof for 20261217, the four narrowings the census needed
// (DEC-30: the app works before and after the paste).

import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin, asCaller, mosDb, seedOrg, selectAs, skipReason, type SeededMember } from "./dbKit";
import { CALLABLE_DEFINERS, TRIGGER_FUNCTIONS } from "./definerDecisions";
import { REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();

interface Live { sig: string; trigger: boolean; anon: boolean; authenticated: boolean; service_role: boolean; pinned: boolean }

function liveDefiners(db: string): Live[] {
  const out = admin(db, `
    SELECT p.oid::regprocedure::text || '|' || (p.prorettype = 'trigger'::regtype)::text || '|' ||
           has_function_privilege('anon', p.oid, 'EXECUTE')::text || '|' ||
           has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '|' ||
           has_function_privilege('service_role', p.oid, 'EXECUTE')::text || '|' ||
           (COALESCE(array_to_string(p.proconfig, ','), '') LIKE '%search_path=public%')::text
      FROM pg_proc p
     WHERE p.prosecdef
       AND p.pronamespace NOT IN ('pg_catalog'::regnamespace, 'information_schema'::regnamespace, 'auth'::regnamespace, 'harness'::regnamespace)
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
     ORDER BY 1`);
  return out.split("\n").filter(Boolean).map((l) => {
    const [sig, trg, a, u, s, pin] = l.split("|");
    return { sig, trigger: trg === "true", anon: a === "true", authenticated: u === "true", service_role: s === "true", pinned: pin === "true" };
  });
}

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
      if (d.decision === "policy-helper-oracle") expect(d.owner, d.signature).toMatch(/INTK-19/);
      if (d.decision === "policy-helper" || d.decision === "policy-helper-oracle") expect(d.execute.anon, d.signature).toBe(true);
      if (d.decision === "service-only" || d.decision === "revoked-20261217") {
        expect(d.execute, d.signature).toEqual({ anon: false, authenticated: false, service_role: true });
      }
    }
  });

  it("a policy-helper decision is true to the catalog: some row-level-security policy really calls it", () => {
    const helpers = CALLABLE_DEFINERS.filter((d) => d.decision.startsWith("policy-helper")).map((d) => d.signature.split("(")[0]);
    for (const name of new Set(helpers)) {
      const n = admin(REPLAY_DB, `SELECT count(*) FROM pg_policy pol WHERE pg_get_expr(pol.polqual, pol.polrelid) ~ '\\m${name}\\(' OR COALESCE(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~ '\\m${name}\\('`);
      expect(Number(n), name).toBeGreaterThan(0);
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

  it("before the paste the anon key can call all four (the gap); after it each is refused 42501", () => {
    const w0 = worlds.before;
    const w1 = worlds.after;
    const anon = { role: "anon" as const };
    // before: reachable — each body answers for itself
    expect(asCaller(before(), anon, `SELECT member_is_active('${w0.orgId}', '${w0.member.uid}')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(before(), anon, `SELECT issue_document_number('${w0.libId}')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(before(), anon, `SELECT next_ticket_number('${w0.orgId}', 2026)`)).toMatchObject({ ok: false, code: "P0001" });
    expect(asCaller(before(), anon, `SELECT force_release_document('${w0.docId}', 'x')`)).toMatchObject({ ok: false, code: "P0001" });
    // after: refused at the door
    for (const call of [
      `SELECT member_is_active('${w1.orgId}', '${w1.member.uid}')`,
      `SELECT issue_document_number('${w1.libId}')`,
      `SELECT next_ticket_number('${w1.orgId}', 2026)`,
      `SELECT force_release_document('${w1.docId}', 'x')`,
    ]) {
      expect(asCaller(after, anon, call), call).toMatchObject({ ok: false, code: "42501" });
    }
    // and a signed-in member can no longer use member_is_active as an oracle
    expect(asCaller(before(), w0.member.caller, `SELECT member_is_active('${w0.orgId}', '${w0.member.uid}')`)).toEqual({ ok: true, rows: 1 });
    expect(asCaller(after, w1.member.caller, `SELECT member_is_active('${w1.orgId}', '${w1.member.uid}')`)).toMatchObject({ ok: false, code: "42501" });
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
});
