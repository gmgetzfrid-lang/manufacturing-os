// admin-and-org Round G — package P7 (audit-log integrity).
//
// ALOG-7: 20261201 — audit_logs.actor_kind and the BEFORE INSERT identity
//   stamp (a signed-in caller's own row is named by the database; the
//   service role's rows keep what the server wrote).
// ALOG-10: 20261202 — the counts-only inventory first, then org_id NOT NULL
//   (or a stop with the count), and audit_logs_insert re-created from its
//   NEWEST definition without the `org_id IS NULL OR` branch; and
//   lib/audit.ts logAuditAction refuses an entry with no workspace.
//
// Both migrations were exercised on a throwaway PostgreSQL 16 (the cases are
// in ALOG-7's and ALOG-10's records); these tests pin the files' shape and
// fidelity by reading the numbered sequence at test time.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const src = (p: string) => readFileSync(join(root, p), "utf8");
const dir = join(root, "supabase", "migrations");
const files = readdirSync(dir).filter((f) => /^\d{8}.*\.sql$/.test(f)).sort();
const mig = (f: string) => readFileSync(join(dir, f), "utf8");
const stripComments = (s: string) => s.replace(/--[^\n]*/g, "");

const M201 = "20261201_ao_roundG_audit_identity.sql";
const M202 = "20261202_ao_roundG_audit_org_required.sql";

function lineDiff(a: string, b: string) {
  const L = a.split("\n"), R = b.split("\n");
  return { onlyInA: L.filter((l) => !R.includes(l)), onlyInB: R.filter((l) => !L.includes(l)) };
}

/** The DEC-30 one-paste shape: the TEMP inventory before BEGIN, one COMMIT,
 *  and exactly one statement after it that is the (check, ok, n) SELECT. */
function dec30Shape(sql: string) {
  const code = stripComments(sql);
  const begin = code.indexOf("\nBEGIN;");
  const commit = code.indexOf("\nCOMMIT;");
  const temp = code.indexOf("CREATE TEMP TABLE");
  return { code, begin, commit, temp };
}

// ── ALOG-7 ────────────────────────────────────────────────────────────────
describe("ALOG-7 — 20261201: the database names a signed-in caller on their own audit row", () => {
  const sql = mig(M201);
  const fnBody = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.audit_logs_stamp_identity()"), sql.indexOf("$$;", sql.indexOf("CREATE OR REPLACE FUNCTION public.audit_logs_stamp_identity()")));

  it("adds actor_kind (nullable, member / server / system) and touches no existing row", () => {
    expect(sql).toContain("ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_kind text;");
    expect(sql).toContain("CHECK (actor_kind IS NULL OR actor_kind IN ('member', 'server', 'system'))");
    // No UPDATE of audit_logs outside the rolled-back self-test (which INSERTs only).
    expect(stripComments(sql)).not.toMatch(/UPDATE\s+(public\.)?audit_logs/i);
    expect(stripComments(sql)).not.toMatch(/DELETE\s+FROM\s+(public\.)?audit_logs/i);
  });

  it("the stamp is SECURITY DEFINER, search_path pinned, and nobody may call it (DRLS-16)", () => {
    expect(fnBody).toMatch(/RETURNS trigger\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public/);
    for (const who of ["PUBLIC", "anon", "authenticated"]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.audit_logs_stamp_identity() FROM ${who};`);
    }
    expect(stripComments(sql)).not.toMatch(/GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+public\.audit_logs_stamp_identity/i);
  });

  it("the service pass returns before any stamp — a machine row keeps user_id NULL (DEC-87 §3: both export ledgers hold)", () => {
    const servicePass = fnBody.indexOf("IF v_uid IS NULL THEN");
    const firstStamp = fnBody.indexOf("NEW.user_email := v_email;");
    expect(servicePass).toBeGreaterThan(0);
    expect(firstStamp).toBeGreaterThan(servicePass);
    expect(fnBody).toContain("NEW.actor_kind := CASE WHEN NEW.user_id IS NULL THEN 'system' ELSE 'server' END;\n    RETURN NEW;");
    // Nothing in the function ever assigns user_id.
    expect(fnBody).not.toMatch(/NEW\.user_id\s*:=/);
  });

  it("a definer function's machine row and its row naming someone else are kept as written", () => {
    expect(fnBody).toContain("IF NEW.user_id IS NULL THEN\n    NEW.actor_kind := 'system';\n    RETURN NEW;");
    expect(fnBody).toContain("IF NEW.user_id <> v_uid THEN\n    NEW.actor_kind := 'server';\n    RETURN NEW;");
  });

  it("the caller's own row: email from the membership (else the sign-in email), a held role kept else the headline, time = now(), kind member", () => {
    expect(fnBody).toContain("FROM org_members m\n     WHERE m.org_id = NEW.org_id AND m.uid = v_uid");
    expect(fnBody).toContain("SELECT u.email INTO v_email FROM auth.users u WHERE u.id = v_uid;");
    expect(fnBody).toContain("AND (NEW.user_role = v_role OR NEW.user_role = ANY (COALESCE(v_roles, '{}'::text[]))) THEN NEW.user_role");
    expect(fnBody).toMatch(/NEW\.user_email := v_email;\s+NEW\.user_role := v_stamped_role;\s+NEW\."timestamp" := now\(\);\s+NEW\.actor_kind := 'member';/);
  });

  it("what the caller sent, when it differs, is kept under metadata.asserted — never dropped", () => {
    expect(fnBody).toContain("v_asserted := v_asserted || jsonb_build_object('user_email', NEW.user_email);");
    expect(fnBody).toContain("v_asserted := v_asserted || jsonb_build_object('user_role', NEW.user_role);");
    expect(fnBody).toContain("v_asserted := v_asserted || jsonb_build_object('timestamp', NEW.\"timestamp\");");
    expect(fnBody).toContain("NEW.metadata || jsonb_build_object('asserted', v_asserted)");
  });

  it("P7 review: metadata.asserted is the database's key — a writer's own is moved to asserted_by_writer BEFORE the merge, so a member cannot plant a discrepancy", () => {
    const strip = fnBody.indexOf("IF NEW.metadata IS NOT NULL AND jsonb_typeof(NEW.metadata) = 'object' AND NEW.metadata ? 'asserted' THEN");
    const moved = fnBody.indexOf("NEW.metadata := (NEW.metadata - 'asserted') || jsonb_build_object('asserted_by_writer', NEW.metadata -> 'asserted');");
    const merge = fnBody.indexOf("IF v_asserted <> '{}'::jsonb THEN");
    expect(strip).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(strip);
    expect(merge).toBeGreaterThan(moved);
    // ...and only on the member branch (after the three early returns that keep a server's / function's row as written)
    expect(strip).toBeGreaterThan(fnBody.indexOf("IF NEW.user_id <> v_uid THEN"));
    // the self-test plants one and the probe reads it back moved
    expect(sql).toContain("jsonb_build_object('asserted', jsonb_build_object('user_email', 'ceo@example.invalid', 'user_role', 'Admin'))");
    expect(sql).toContain("AND NOT (v_plant.metadata ? 'asserted')");
    expect(sql).toContain("(SELECT ok FROM _ao_g201_selftest WHERE probe = 'planted')");
    expect(sql).toContain("expect ok = true × 14");
  });

  it("the trigger is BEFORE INSERT FOR EACH ROW, and no other file defines the function or the trigger", () => {
    expect(sql).toMatch(/CREATE TRIGGER trg_audit_logs_identity\s+BEFORE INSERT ON audit_logs\s+FOR EACH ROW\s+EXECUTE FUNCTION public\.audit_logs_stamp_identity\(\);/);
    const definers = files.filter((f) => /audit_logs_stamp_identity\(\)\s*\nRETURNS/.test(stripComments(mig(f))) || /CREATE TRIGGER trg_audit_logs_identity/.test(stripComments(mig(f))));
    expect(definers).toEqual([M201]);
  });

  it("has the DEC-30 one-paste shape: counts-only TEMP inventory before BEGIN; one final (check, ok, n) SELECT", () => {
    const { code, begin, commit, temp } = dec30Shape(sql);
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    expect(commit).toBeGreaterThan(begin);
    const inv = code.slice(temp, begin);
    expect(inv).toMatch(/COUNT\(\*\)::text/);
    expect(inv).not.toMatch(/SELECT\s+\*|user_email\s+AS|string_agg|array_agg/i);
    const tail = code.slice(commit);
    expect(tail).toMatch(/SELECT 'audit_logs\.actor_kind exists \(text, nullable\)' AS check,[\s\S]*AS ok,\s+NULL::text AS n/);
    // The self-test's rows are rolled back (a raised exception inside a sub-block).
    expect(tail).toContain("RAISE EXCEPTION 'ao_g201_selftest_rollback';");
    // Exactly one top-level SELECT result set after the DO block.
    const afterDo = tail.slice(tail.indexOf("$selftest$;") + "$selftest$;".length);
    expect((afterDo.match(/;\s*$/gm) ?? []).length).toBe(1);
  });
});

// ── ALOG-10 ───────────────────────────────────────────────────────────────
describe("ALOG-10 — 20261202: no audit row without a workspace", () => {
  const sql = mig(M202);
  const POLICY = /CREATE POLICY audit_logs_insert ON audit_logs\s*\n[\s\S]*?\);/;

  it("re-creates audit_logs_insert from its NEWEST earlier definition (scanned) with exactly the NULL branch removed", () => {
    const defining = files.filter((f) => POLICY.test(stripComments(mig(f))));
    expect(defining[defining.length - 1]).toBe(M202);
    const prev = defining[defining.indexOf(M202) - 1];
    expect(prev).toBe("20260813_acl_close_gaps_and_audit_scope.sql");
    const live = POLICY.exec(stripComments(mig(prev)))![0];
    const next = POLICY.exec(stripComments(sql))![0];
    const { onlyInA, onlyInB } = lineDiff(live, next);
    expect(onlyInA).toEqual(["    AND (org_id IS NULL OR org_id IN (SELECT my_org_ids()))"]);
    expect(onlyInB).toEqual(["    AND org_id IN (SELECT my_org_ids())"]);
  });

  it("no later migration re-creates audit_logs_insert (this file's body is the live one once pasted)", () => {
    const after = files.filter((f) => f > M202 && /audit_logs_insert/.test(stripComments(mig(f))));
    expect(after).toEqual([]);
  });

  it("chooses its world from the rows: NOT NULL when none lacks a workspace; else STOPS with the count, unless the operator kept them (NOT VALID check)", () => {
    const code = stripComments(sql);
    expect(code).toContain("IF v_null = 0 THEN\n    ALTER TABLE audit_logs ALTER COLUMN org_id SET NOT NULL;");
    expect(code).toContain("ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_org_id_present CHECK (org_id IS NOT NULL) NOT VALID;");
    expect(code).toMatch(/RAISE EXCEPTION 'ALOG-10 \(20261202\): % audit row\(s\) name no workspace \(org_id IS NULL\)\. Nothing was changed and nothing was deleted\./);
    expect(code).toContain("current_setting('alog10.keep_unscoped_rows', true)");
    // P7 review: the lock is said, and the WAIT for it bounded inside the transaction.
    expect(sql).toMatch(/LOCKS AND HOW LONG[\s\S]*ACCESS EXCLUSIVE on audit_logs and reads every row/);
    const begin = code.indexOf("\nBEGIN;");
    expect(code.indexOf("SET LOCAL lock_timeout = '5s';")).toBeGreaterThan(begin);
    expect(code.indexOf("SET LOCAL lock_timeout = '5s';")).toBeLessThan(code.indexOf("ALTER TABLE audit_logs ALTER COLUMN org_id SET NOT NULL;"));
    expect(code).toContain("'inventory: audit_logs rows in all (SET NOT NULL reads each of them while it holds ACCESS EXCLUSIVE");
    // Audit rows are never deleted or rewritten.
    expect(code).not.toMatch(/DELETE\s+FROM\s+(public\.)?audit_logs/i);
    expect(code).not.toMatch(/UPDATE\s+(public\.)?audit_logs/i);
  });

  it("has the DEC-30 shape: counts-only inventory before BEGIN; one final (check, ok, n) SELECT", () => {
    const { code, begin, commit, temp } = dec30Shape(sql);
    expect(temp).toBeGreaterThan(-1);
    expect(temp).toBeLessThan(begin);
    const inv = code.slice(temp, begin);
    expect(inv).toMatch(/COUNT\(\*\)::text/);
    const tail = code.slice(commit + "\nCOMMIT;".length);
    expect((tail.match(/;\s*$/gm) ?? []).length).toBe(1);
    expect(tail).toMatch(/AS check,[\s\S]*AS ok,\s+NULL::text AS n/);
  });

  it("every audit row writer names its workspace: each SQL INSERT INTO audit_logs lists org_id, and each app file that inserts one carries org_id", () => {
    for (const f of files) {
      if (f === M201) continue; // the rolled-back self-test lists org_id too, checked below
      for (const m of stripComments(mig(f)).matchAll(/INSERT INTO (?:public\.)?audit_logs\s*\(([^)]*)\)/gi)) {
        expect({ f, cols: m[1].split(",").map((c) => c.trim()).includes("org_id") }).toEqual({ f, cols: true });
      }
    }
    const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? (e.name === "__tests__" || e.name === "node_modules" ? [] : walk(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : []);
    const sites = ["app", "lib", "components", "hooks"].flatMap(walk).filter((p) => /from\(\s*["']audit_logs["']\s*\)\s*\.(insert|upsert)/.test(src(p)));
    expect(sites.length).toBeGreaterThan(40);
    for (const p of sites) expect({ p, org: /\borg_id\b/.test(src(p)) }).toEqual({ p, org: true });
  });
});

// ── lib/audit.ts ────────────────────────────────────────────────────────────
const h = vi.hoisted(() => ({ inserts: [] as Array<Record<string, unknown>>, error: null as { message: string } | null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (t: string) => ({
      insert: async (row: Record<string, unknown>) => { h.inserts.push({ table: t, ...row }); return { error: h.error }; },
    }),
  },
}));

describe("lib/audit.ts logAuditAction — ALOG-10 done-when 2 and ALOG-7 done-when 3 (signature unchanged)", () => {
  beforeEach(() => { h.inserts = []; h.error = null; });

  it("an entry with no workspace is refused and logged, never written (and never thrown)", async () => {
    const { logAuditAction } = await import("@/lib/audit");
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const orgId of [undefined, "", "   "]) {
        const r = await logAuditAction({ action: "TICKET_ROOT_CAUSE_UPDATE", resourceId: "t1", resourceType: "ticket", orgId, userId: "u1" });
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/no workspace named/);
      }
      expect(h.inserts).toEqual([]);
      expect(err).toHaveBeenCalledWith(expect.stringMatching(/Failed to write audit log \(TICKET_ROOT_CAUSE_UPDATE\)/), expect.stringMatching(/no workspace/));
    } finally { err.mockRestore(); }
  });

  it("regression: a normal entry is written exactly as before (no timestamp key — the database clocks the row)", async () => {
    const { logAuditAction } = await import("@/lib/audit");
    const r = await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: "o1", userId: "u1", userEmail: "a@b.c", userRole: "Drafter", details: { fileName: "x.pdf" } });
    expect(r).toEqual({ error: null, ok: true });
    expect(h.inserts).toEqual([{
      table: "audit_logs", action: "VIEW", resource_id: "d1", resource_type: "document", org_id: "o1",
      user_id: "u1", user_email: "a@b.c", user_role: "Drafter", details: { fileName: "x.pdf" }, metadata: null,
    }]);
  });

  it("ALOG-7 done-when 3: the exported signature is kept (logAuditAction(entry: AuditEntry)) and a timestamp a writer passes is never written — the database clocks the row", async () => {
    const audit = readFileSync(join(root, "lib/audit.ts"), "utf8");
    expect(audit).toMatch(/export async function logAuditAction\(entry: AuditEntry\): Promise<\{ error: string \| null; ok: boolean \}>/);
    expect(audit).not.toContain("AuditWriteEntry");
    const body = audit.slice(audit.indexOf("export async function logAuditAction("), audit.indexOf("\n}\n", audit.indexOf("export async function logAuditAction(")));
    expect(body).not.toMatch(/timestamp/);
    const { logAuditAction } = await import("@/lib/audit");
    await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: "o1", userId: "u1", timestamp: "2020-01-01T00:00:00Z" });
    expect(h.inserts[0]).not.toHaveProperty("timestamp");
  });

  it("the DF-P1 stand-in rule is unchanged: a sentinel actor writes user_id NULL with metadata.actor_kind system", async () => {
    const { logAuditAction } = await import("@/lib/audit");
    await logAuditAction({ action: "REVIEW_ALTERNATE_ACTIVATED", resourceId: "s1", resourceType: "document", orgId: "o1", userId: "" });
    expect(h.inserts[0]).toMatchObject({ user_id: null, metadata: { actor_kind: "system" } });
  });

  it("a refused insert is still returned, not swallowed", async () => {
    const { logAuditAction } = await import("@/lib/audit");
    h.error = { message: "new row violates row-level security policy" };
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await logAuditAction({ action: "VIEW", resourceId: "d1", resourceType: "document", orgId: "o1", userId: "u1" }))
        .toEqual({ error: "new row violates row-level security policy", ok: false });
    } finally { err.mockRestore(); }
  });
});
