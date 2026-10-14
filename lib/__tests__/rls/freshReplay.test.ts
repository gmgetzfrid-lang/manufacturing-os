// IRLS-6 (intelligence I-17): the fresh-install replay, automated.
//
// supabase/schema.sql and every numbered migration, in filename order, onto
// an empty PostgreSQL 16 carrying the Supabase stand-in (globalSetup.ts runs
// the replay once; replay.ts says how each file is sent). Then the admin
// schema-health route's own GET handler is run against that fresh install.

import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { admin, asCaller, mosDb, skipReason } from "./dbKit";
import { BASELINE_KNOWN_ERRORS, OUT_OF_ORDER_FILES, OPERATOR_SWITCHES } from "./replayKnownDefects";
import { numberedMigrations, REPLAY_DB } from "./replay";
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

  it("supabase/schema.sql: the statements that fail on an empty database are exactly the recorded IRLS-17 set", () => {
    expect([...report().baselineErrors].sort()).toEqual([...BASELINE_KNOWN_ERRORS].sort());
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

  it("a rolled-back out-of-order file succeeds when re-run after the sequence", () => {
    const failed = report().retries.filter((r) => !r.ok).map((r) => `${r.file}: ${r.error}`);
    expect(failed).toEqual([]);
    expect(report().retries.map((r) => r.file)).toContain("20260630_perf_indexes.sql");
    expect(admin(REPLAY_DB, "SELECT to_regclass('public.team_members_uid_idx') IS NOT NULL")).toBe("t");
  });

  it("20261075 cannot be pasted as written: the editor parses the whole script first, so its final SELECT's syntax error leaves the guard uninstalled (IRLS-19)", () => {
    expect(admin(REPLAY_DB, `SELECT count(*) FROM pg_trigger WHERE tgname = 'trg_checkout_episode_guard' AND tgrelid = 'checkout_episodes'::regclass`)).toBe("0");
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

    it("reports every EXPECTED_TABLE, column and function present", async () => {
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
