// IRLS-6 (intelligence I-17): the fresh-install replay, automated.
//
// supabase/schema.sql and every numbered migration, in filename order, onto
// an empty PostgreSQL 16 carrying the Supabase stand-in (globalSetup.ts runs
// the replay once; replay.ts says how each file is sent). Then the admin
// schema-health route's own GET handler is run against that fresh install.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admin, asCaller, mosDb, seedOrg, skipReason } from "./dbKit";
import { BASELINE_KNOWN_ERRORS, OUT_OF_ORDER_FILES, OPERATOR_SWITCHES } from "./replayKnownDefects";
import { MAX_C_BYTES, numberedMigrations, REPLAY_DB } from "./replay";
import { runPsql } from "./pgHarness";

const skip = skipReason();

// ── a PostgREST stand-in for the schema-health route, answered by the
//    replayed database itself as the service role ──────────────────────────
const h = vi.hoisted(() => ({ db: "" }));

// PostgREST types each RPC argument by the function's own parameter (its
// json_to_record step), so every value goes in as an untyped literal and
// PostgreSQL resolves it against the parameter: an array as an array
// literal, an object as JSON text.
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  const quote = (t: string) => `'${t.replace(/'/g, "''")}'`;
  if (Array.isArray(v)) return quote(`{${v.map((x) => `"${String(x).replace(/(["\\])/g, "\\$1")}"`).join(",")}}`);
  if (typeof v === "object") return quote(JSON.stringify(v));
  return quote(String(v));
}

function pgAnswer(statement: string): { error: { code: string; message: string } | null } {
  const o = asCaller(h.db, { role: "service_role" }, statement);
  if (o.ok) return { error: null };
  // PostgREST's own words for "not in the schema cache"
  if (o.code === "42883") return { error: { code: "PGRST202", message: o.message } };
  return { error: { code: o.code, message: o.message } };
}

vi.mock("@/lib/supabaseAdmin", () => {
  const from = (table: string) => {
    let cols = "*";
    const chain: Record<string, unknown> = {};
    chain.select = (c: string) => { cols = c; return chain; };
    chain.eq = () => chain;
    // the route's own membership read: the caller is an Admin
    chain.maybeSingle = async () => (table === "org_members" ? { data: { role: "Admin", roles: [] }, error: null } : { data: null, error: null });
    chain.limit = () => ({
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(pgAnswer(`SELECT ${cols} FROM public.${table} LIMIT 0`)).then(res, rej),
    });
    return chain;
  };
  return {
    supabaseAdmin: {
      auth: { getUser: async () => ({ data: { user: { id: "00000000-0000-4000-8000-000000000001" } }, error: null }) },
      from,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        const named = Object.entries(args).map(([k, v]) => `${k} => ${sqlLiteral(v)}`).join(", ");
        return pgAnswer(`SELECT public.${fn}(${named})`);
      },
    },
  };
});

describe.skipIf(skip !== null)("IRLS-6: a fresh install replays in filename order", () => {
  const report = () => mosDb().report!;

  it("the census sees the whole sequence", () => {
    const r = report();
    expect(r.files.map((f) => f.file)).toEqual(numberedMigrations(process.cwd()));
    expect(r.files.length).toBeGreaterThan(290);
    expect(r.engine).toMatch(/PostgreSQL 1[6-9]/);
  });

  it("every numbered migration fits in one simple-query message (the replay stops on one that does not, naming it)", () => {
    // Checked here, in the opt-in run, never in the default suite: the limit
    // is the harness's transport's (psql -c), not the app's or the editor's.
    const over = numberedMigrations(process.cwd())
      .map((f) => ({ f, bytes: statSync(join(process.cwd(), "supabase", "migrations", f)).size }))
      .filter((x) => x.bytes > MAX_C_BYTES);
    expect(over).toEqual([]);
  });

  it("IRLS-17: supabase/schema.sql, sent as ONE script (the editor's way), runs on the empty stand-in with zero errors", () => {
    expect(BASELINE_KNOWN_ERRORS).toEqual([]);
    expect([...report().baselineErrors].sort()).toEqual([...BASELINE_KNOWN_ERRORS].sort());
    // the file still fits in one simple-query message
    expect(statSync(join(process.cwd(), "supabase", "schema.sql")).size).toBeLessThanOrEqual(MAX_C_BYTES);
  });

  it("IRLS-6 done-when 2: zero errors — schema.sql as one script, then every numbered migration in filename order, nothing re-run", () => {
    const r = report();
    expect(r.baselineErrors).toEqual([]);
    expect(r.files.filter((f) => !f.ok).map((f) => `${f.file}: ${f.error}`)).toEqual([]);
    expect(r.retries).toEqual([]);
    // the one operator switch is the documented one, for its file alone
    expect(Object.keys(OPERATOR_SWITCHES)).toEqual(["20261141_prj_roundG_intake_token_hash_and_adoption.sql"]);
  });

  it("IRLS-17: schema.sql alone, pasted as one script on an empty database, ends with its bootstrap census — nothing unprotected, the trigram index built, and the tables only the migrations make absent", () => {
    const db = "mos_irls17_alone";
    const { conn } = mosDb();
    admin("postgres", `CREATE DATABASE ${db}`);
    try {
      const standIn = runPsql(conn!, db, conn!.superuser, { file: join(process.cwd(), "lib", "__tests__", "rls", "supabaseStandIn.sql"), stopOnError: true });
      expect(standIn.ok).toBe(true);
      const r = runPsql(conn!, db, "postgres", { sql: readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8") });
      expect(r.errors).toEqual([]);
      expect(r.ok).toBe(true);
      // the last result set the editor shows: table|state rows, none unprotected
      const census = r.stdout.split("\n").filter((l) => l.includes("|"));
      expect(census.length).toBeGreaterThan(10);
      expect(census.filter((l) => /RLS DISABLED/.test(l))).toEqual([]);
      for (const l of census) expect(l).toMatch(/^[a-z_0-9]+\|locked — no policy yet: apply the migrations$/);
      expect(census).toContain("projects|locked — no policy yet: apply the migrations");
      // RLS is on for every table the file made
      expect(admin(db, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity`)).toBe("0");
      expect(Number(admin(db, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r'`))).toBeGreaterThan(40);
      // the CREATE EXTENSION that sat at the end of a comment line now runs
      expect(admin(db, `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'tickets_ticket_id_trgm_idx'`)).toBe(
        "CREATE INDEX tickets_ticket_id_trgm_idx ON public.tickets USING gin (ticket_id gin_trgm_ops)",
      );
      // the forward-referencing tables are the migrations' (20260609, 20260614), and the archived index is 20260808's
      for (const t of ["project_documents", "milestones", "document_assets", "document_versions_archived_idx"]) {
        expect(admin(db, `SELECT to_regclass('public.${t}') IS NULL`), t).toBe("t");
      }
    } finally {
      admin("postgres", `DROP DATABASE ${db}`);
    }
  });

  it("IRLS-17: every statement schema.sql gained is a no-op on an existing (fully migrated) database", () => {
    // schema.sql is never re-run on a live database (its header, DB-8); this
    // shows the changes would not matter even if it were. The removals cannot
    // touch a database; the three statements it gained are these.
    const gained = [
      "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
      "CREATE INDEX IF NOT EXISTS tickets_ticket_id_trgm_idx ON tickets USING GIN (ticket_id gin_trgm_ops);",
      "ALTER TABLE IF EXISTS document_assets ENABLE ROW LEVEL SECURITY;",
    ];
    const schema = readFileSync(join(process.cwd(), "supabase", "schema.sql"), "utf8");
    for (const g of gained) expect(schema.split("\n").some((l) => l.startsWith(g)), g).toBe(true);
    const db = "mos_irls17_existing";
    admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${REPLAY_DB}`);
    try {
      const state = () => admin(db, `SELECT (SELECT oid::text || ' ' || extversion FROM pg_extension WHERE extname = 'pg_trgm')
        || ' / ' || (SELECT c.oid::text || ' ' || pg_get_indexdef(c.oid) FROM pg_class c WHERE c.relname = 'tickets_ticket_id_trgm_idx')
        || ' / ' || (SELECT relrowsecurity::text FROM pg_class WHERE oid = 'public.document_assets'::regclass)`);
      const before = state();
      expect(before).toMatch(/ \/ true$/);
      const r = runPsql(mosDb().conn!, db, "postgres", { sql: gained.join("\n") });
      expect(r.errors).toEqual([]);
      expect(state()).toBe(before);
    } finally {
      admin("postgres", `DROP DATABASE ${db}`);
    }
  });

  it("every numbered migration runs in filename order, except the recorded out-of-order files", () => {
    const known = new Set(OUT_OF_ORDER_FILES.map((k) => k.file));
    const unexpected = report().files.filter((f) => !f.ok && !known.has(f.file)).map((f) => `${f.file}: ${f.error}`);
    expect(unexpected).toEqual([]);
  });

  it("each recorded out-of-order file still fails the way it is recorded (remove the entry when its owner fixes it)", () => {
    for (const k of OUT_OF_ORDER_FILES) {
      const f = report().files.find((x) => x.file === k.file);
      expect(f, k.file).toBeDefined();
      expect(f!.ok, `${k.file} now replays clean — remove it from OUT_OF_ORDER_FILES and close ${k.finding}`).toBe(false);
      expect(f!.error ?? "").toMatch(k.error);
    }
  });

  it("no file needed a re-run after the sequence (IRLS-18): 20260630 replays in filename order and every index it names exists", () => {
    expect(OUT_OF_ORDER_FILES).toEqual([]);
    expect(report().retries).toEqual([]);
    expect(report().files.find((x) => x.file === "20260630_perf_indexes.sql")?.ok).toBe(true);
    for (const ix of ["documents_folder_listing_idx", "collections_org_library_idx", "org_members_uid_org_active_idx", "team_members_uid_idx"]) {
      expect(admin(REPLAY_DB, `SELECT to_regclass('public.${ix}') IS NOT NULL`), ix).toBe("t");
    }
    // the index 20260707 builds with the table: the one 20260630 named, the
    // same definition the old re-paste of 20260630 produced
    expect(admin(REPLAY_DB, `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'team_members_uid_idx'`)).toBe(
      "CREATE INDEX team_members_uid_idx ON public.team_members USING btree (uid)",
    );
  });

  it("IRLS-18: on an already-migrated database, re-pasting 20260630 — as corrected, or as it stood — changes nothing (every index keeps its oid and definition)", () => {
    const db = "mos_irls18";
    admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${REPLAY_DB}`);
    try {
      const snapshot = () => admin(db, `SELECT string_agg(c.oid::text || ' ' || pg_get_indexdef(c.oid), E'\n' ORDER BY c.relname)
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE i.indrelid IN ('documents'::regclass, 'collections'::regclass, 'org_members'::regclass, 'team_members'::regclass)`);
      const before = snapshot();
      expect(before).toContain("team_members_uid_idx ON public.team_members USING btree (uid)");
      const fixed = readFileSync(join(process.cwd(), "supabase", "migrations", "20260630_perf_indexes.sql"), "utf8");
      const r = runPsql(mosDb().conn!, db, "postgres", { sql: fixed });
      expect(r.errors).toEqual([]);
      expect(snapshot()).toBe(before);
      // the file as it stood before the guard (what every live database ran)
      const at = fixed.indexOf("-- team_members is created by 20260707_teams.sql");
      expect(at).toBeGreaterThan(0);
      const preFix = fixed.slice(0, at) + "CREATE INDEX IF NOT EXISTS team_members_uid_idx\n  ON team_members (uid);\n";
      const old = runPsql(mosDb().conn!, db, "postgres", { sql: preFix });
      expect(old.errors).toEqual([]);
      expect(snapshot()).toBe(before);
    } finally {
      admin("postgres", `DROP DATABASE ${db}`);
    }
  });

  it("20261075 replays in filename order: the checkout-episode guard is installed on the fresh install (IRLS-19)", () => {
    expect(report().files.find((x) => x.file === "20261075_dc_roundF_checkout_episode_seal.sql")?.ok).toBe(true);
    expect(admin(REPLAY_DB, `SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_checkout_episode_guard' AND tgrelid = 'checkout_episodes'::regclass AND NOT tgisinternal`)).toBe("1");
    expect(admin(REPLAY_DB, `SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%' FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard'`)).toBe("t");
  });

  // IRLS-19, corrected in place (intelligence I-27): the file now parses, so
  // it applies the same way whichever way it is sent, on a copy of the
  // sequence up to (not including) 20261075, and a re-paste changes nothing.
  const f75 = "20261075_dc_roundF_checkout_episode_seal.sql";
  const installed = (db: string) => admin(db, `SELECT (SELECT count(*) FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard') || '/' || (SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_checkout_episode_guard')`);
  /** A copy of the replay without 20261075's objects: the sequence up to that file, as an operator who never pasted it has. */
  const withoutF75 = (db: string) => {
    admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${REPLAY_DB}`);
    admin(db, "DROP TRIGGER trg_checkout_episode_guard ON checkout_episodes; DROP FUNCTION enforce_checkout_episode_guard();");
    expect(installed(db)).toBe("0/0");
  };
  // The final SELECT the SQL editor shows: five probes (ok = true, n NULL),
  // then the four counts-only inventory rows (ok NULL, n a count).
  const EXPECTED_FINAL_SELECT = [
    /^guard installed: BEFORE UPDATE ON checkout_episodes, FOR EACH ROW\|t\|$/,
    /^closed episodes are immutable to signed-in writers\|t\|$/,
    /^an episode cannot be sealed over an active member session\|t\|$/,
    /^service role passes \(auth\.uid\(\) IS NULL → RETURN NEW\)\|t\|$/,
    /^search_path pinned on the guard\|t\|$/,
    /^inventory: closed episodes that still carry an active member session \(residue the rail now prevents\)\|\|\d+$/,
    /^inventory: active episodes with NO active member session \(stray opens; reconcile closes them\)\|\|\d+$/,
    /^inventory: closed episodes \(all orgs\)\|\|\d+$/,
    /^inventory: active episodes \(all orgs\)\|\|\d+$/,
  ];
  for (const mode of ["one script (the SQL editor's paste)", "statement by statement (psql -f)"] as const) {
    it(`IRLS-19: 20261075 sent as ${mode} applies with no error and installs the guard`, () => {
      const db = "mos_irls19";
      withoutF75(db);
      try {
        const path = join(process.cwd(), "supabase", "migrations", f75);
        const r = mode.startsWith("one")
          ? runPsql(mosDb().conn!, db, "postgres", { sql: readFileSync(path, "utf8") })
          : runPsql(mosDb().conn!, db, "postgres", { file: path, stopOnError: true });
        expect(r.errors).toEqual([]);
        expect(r.ok).toBe(true);
        expect(installed(db)).toBe("1/1");
        expect(admin(db, `SELECT prosecdef AND array_to_string(proconfig, ',') LIKE '%search_path=public%' FROM pg_proc WHERE proname = 'enforce_checkout_episode_guard'`)).toBe("t");
        if (mode.startsWith("one")) {
          // the one result set the editor shows is the file's final SELECT, exactly
          const rows = r.stdout.split("\n").filter((l) => l.includes("|"));
          expect(rows).toHaveLength(EXPECTED_FINAL_SELECT.length);
          rows.forEach((row, i) => expect(row).toMatch(EXPECTED_FINAL_SELECT[i]));
          // "Idempotent; safe to re-run": a second paste answers the same and leaves one guard
          const again = runPsql(mosDb().conn!, db, "postgres", { sql: readFileSync(path, "utf8") });
          expect(again.errors).toEqual([]);
          expect(again.stdout.split("\n").filter((l) => l.includes("|"))).toEqual(rows);
          expect(installed(db)).toBe("1/1");
        }
      } finally {
        admin("postgres", `DROP DATABASE ${db}`);
      }
    });
  }

  it("IRLS-19: a database that ran the pre-fix file statement by statement (everything but its final SELECT applied) takes the corrected paste cleanly and ends the same", () => {
    const db = "mos_irls19_prefix";
    withoutF75(db);
    const dir = mkdtempSync(join(tmpdir(), "mos-irls19-"));
    try {
      const fixed = readFileSync(join(process.cwd(), "supabase", "migrations", f75), "utf8");
      // the file as it stood before the correction: the one identifier bare
      const preFix = fixed.replace('SELECT "check", NULL::boolean, n FROM _dc_roundf_episode_seal_inventory;', "SELECT check, NULL::boolean, n FROM _dc_roundf_episode_seal_inventory;");
      expect(preFix).not.toBe(fixed);
      // one script, the pre-fix file applies nothing (the editor's outcome before the correction)
      const pasted = runPsql(mosDb().conn!, db, "postgres", { sql: preFix });
      expect(pasted.errors).toEqual(['syntax error at or near "check"']);
      expect(installed(db)).toBe("0/0");
      // statement by statement, it applied everything but the final SELECT
      const path = join(dir, f75);
      writeFileSync(path, preFix);
      const partial = runPsql(mosDb().conn!, db, "postgres", { file: path, stopOnError: false });
      expect(partial.errors).toEqual(['syntax error at or near "check"']);
      expect(installed(db)).toBe("1/1");
      const def = (d: string) => admin(d, `SELECT md5(pg_get_functiondef('enforce_checkout_episode_guard()'::regprocedure)) || '/' || (SELECT md5(pg_get_triggerdef(oid)) FROM pg_trigger WHERE tgname = 'trg_checkout_episode_guard')`);
      const before = def(db);
      // the corrected paste re-runs over it with no error and the same definitions
      const r = runPsql(mosDb().conn!, db, "postgres", { sql: fixed });
      expect(r.errors).toEqual([]);
      expect(installed(db)).toBe("1/1");
      expect(def(db)).toBe(before);
      expect(def(REPLAY_DB)).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      admin("postgres", `DROP DATABASE ${db}`);
    }
  });

  it("IRLS-19: the installed guard does what DCK-14 asks — a closed episode is sealed to a signed-in writer, a close over a live session is refused, the service role and a clean close pass", () => {
    const db = "mos_irls19_guard";
    admin("postgres", `CREATE DATABASE ${db} TEMPLATE ${REPLAY_DB}`);
    try {
      const { orgId, m } = seedOrg(db, { member: { role: "Engineer" } });
      const libId = randomUUID();
      const docId = randomUUID();
      const closedEp = randomUUID();
      const liveEp = randomUUID();
      const doc2 = randomUUID();
      const cleanEp = randomUUID();
      admin(db, `INSERT INTO libraries (id, org_id, name, type) VALUES ('${libId}', '${orgId}', 'Drawings', 'documents');
        INSERT INTO documents (id, org_id, library_id, title, status) VALUES ('${docId}', '${orgId}', '${libId}', 'P&ID 300', 'Draft'), ('${doc2}', '${orgId}', '${libId}', 'P&ID 301', 'Draft');
        INSERT INTO checkout_episodes (id, org_id, document_id, library_id, seq, status, closed_at, close_reason) VALUES ('${closedEp}', '${orgId}', '${docId}', '${libId}', 1, 'closed', now(), 'released');
        INSERT INTO checkout_episodes (id, org_id, document_id, library_id, seq, status) VALUES ('${liveEp}', '${orgId}', '${docId}', '${libId}', 2, 'active'), ('${cleanEp}', '${orgId}', '${doc2}', '${libId}', 1, 'active');
        INSERT INTO checkout_sessions (org_id, document_id, library_id, user_id, mode, status, episode_id) VALUES ('${orgId}', '${docId}', '${libId}', '${m.member.uid}', 'edit', 'active', '${liveEp}');`);
      const sealed = asCaller(db, m.member.caller, `UPDATE checkout_episodes SET close_reason = 'rewritten' WHERE id = '${closedEp}'`);
      expect(sealed).toMatchObject({ ok: false, code: "23514" });
      expect(!sealed.ok && sealed.message).toMatch(/sealed record and cannot be changed/);
      const reopen = asCaller(db, m.member.caller, `UPDATE checkout_episodes SET status = 'active' WHERE id = '${closedEp}'`);
      expect(reopen).toMatchObject({ ok: false, code: "23514" });
      const overLive = asCaller(db, m.member.caller, `UPDATE checkout_episodes SET status = 'closed', closed_at = now() WHERE id = '${liveEp}'`);
      expect(overLive).toMatchObject({ ok: false, code: "23514" });
      expect(!overLive.ok && overLive.message).toMatch(/still has active sessions and cannot be sealed/);
      // today's legitimate flows keep working: a close with nobody left on it, and the trusted backend
      expect(asCaller(db, m.member.caller, `UPDATE checkout_episodes SET status = 'closed', closed_at = now() WHERE id = '${cleanEp}'`)).toEqual({ ok: true, rows: 1 });
      expect(asCaller(db, { role: "service_role" }, `UPDATE checkout_episodes SET close_reason = 'swept' WHERE id = '${closedEp}'`)).toEqual({ ok: true, rows: 1 });
    } finally {
      admin("postgres", `DROP DATABASE ${db}`);
    }
  });

  it("the operator-gated file refuses without its switch and changes nothing (the harness supplies only the documented switch)", () => {
    const file = "20261141_prj_roundG_intake_token_hash_and_adoption.sql";
    expect(Object.keys(OPERATOR_SWITCHES)).toEqual([file]);
    const { conn } = mosDb();
    const body = readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8");
    const r = runPsql(conn!, REPLAY_DB, "postgres", { sql: body });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/DEPLOY PREREQUISITE/);
  });

  it("IRLS-6's own defect is gone: 20260806 / 20260807 / 20261123 replay clean and knowledge_questions carries its search column and indexes", () => {
    for (const f of ["20260806_intelligence_layer.sql", "20260807_link_proposals.sql", "20261123_intel_roundG_knowledge_questions_order.sql"]) {
      expect(report().files.find((x) => x.file === f)?.ok, f).toBe(true);
    }
    expect(admin(REPLAY_DB, `SELECT attgenerated FROM pg_attribute WHERE attrelid = 'knowledge_questions'::regclass AND attname = 'search_tsv'`)).toBe("s");
    for (const t of ["org_ai_instructions", "document_related_resources", "recently_viewed_docs", "library_numbering"]) {
      expect(admin(REPLAY_DB, `SELECT to_regclass('public.${t}') IS NOT NULL`), t).toBe("t");
    }
  });

  describe("/api/admin/schema-health against the fresh install", () => {
    beforeAll(() => { h.db = REPLAY_DB; });

    it("reports every EXPECTED_TABLE, column and function present (IRLS-6 done-when 3: the literal fresh install, read through the PostgREST stand-in — DEC-90)", async () => {
      // the install is the literal one: schema.sql as one script, every file in order, nothing re-run
      expect(report().baselineErrors).toEqual([]);
      expect(report().files.every((f) => f.ok)).toBe(true);
      expect(report().retries).toEqual([]);
      const { GET } = await import("@/app/api/admin/schema-health/route");
      const { NextRequest } = await import("next/server");
      const req = new NextRequest("http://localhost/api/admin/schema-health?orgId=00000000-0000-4000-8000-0000000000aa", {
        headers: { authorization: "Bearer harness" },
      });
      const res = await GET(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.missingTables).toEqual([]);
      expect(body.missingColumns).toEqual([]);
      expect(body.migrationsToRun).toEqual([]);
      expect(body.healthy).toBe(true);
      expect(body.checkedTables).toBeGreaterThan(100);
      expect(body.checkedFunctions).toBeGreaterThan(5);
    }, 120_000);

    it("the stand-in is not vacuous: a dropped table and a dropped function are reported missing", async () => {
      const scratch = "mos_health_probe";
      admin("postgres", `CREATE DATABASE ${scratch} TEMPLATE ${REPLAY_DB}`);
      try {
        admin(scratch, "DROP TABLE public.library_numbering CASCADE; DROP FUNCTION public.bump_share_access(uuid);");
        h.db = scratch;
        const { GET } = await import("@/app/api/admin/schema-health/route");
        const { NextRequest } = await import("next/server");
        const res = await GET(new NextRequest("http://localhost/api/admin/schema-health?orgId=00000000-0000-4000-8000-0000000000aa", { headers: { authorization: "Bearer harness" } }));
        const body = await res.json();
        expect(body.healthy).toBe(false);
        const names = body.missingTables.map((t: { table: string }) => t.table);
        expect(names).toContain("library_numbering");
        expect(names).toContain("bump_share_access(uuid)");
      } finally {
        h.db = REPLAY_DB;
        admin("postgres", `DROP DATABASE ${scratch}`);
      }
    }, 120_000);
  });
});
